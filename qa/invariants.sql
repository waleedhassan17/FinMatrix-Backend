-- ═══════════════════════════════════════════════════════════════════
-- FinMatrix ledger invariants (ACCOUNTING_QA_GUIDE §2).
--
-- EVERY query must return ZERO rows. Any row returned is a defect.
-- Run with qa/run-qa.sh, which fails the build on any output.
--
-- I12 differs deliberately from the audited version — see the note there.
-- ═══════════════════════════════════════════════════════════════════

-- I1. Global double-entry: total debits must equal total credits
-- Drafts excluded throughout: PostingService validates line SHAPE for every
-- status but only asserts balance when posting, so an unbalanced draft is a
-- supported working state, not a defect.
SELECT 'I1 GLOBAL IMBALANCE' AS violation, sum(l.debit) AS dr, sum(l.credit) AS cr
FROM journal_entry_lines l JOIN journal_entries e ON e.id=l.entry_id
WHERE e.status <> 'draft'
HAVING sum(l.debit) <> sum(l.credit);

-- I2. Every individual entry must balance
SELECT 'I2 UNBALANCED ENTRY' AS violation, l.entry_id,
       sum(l.debit) dr, sum(l.credit) cr
FROM journal_entry_lines l JOIN journal_entries e ON e.id=l.entry_id
WHERE e.status <> 'draft'
GROUP BY l.entry_id HAVING sum(l.debit) <> sum(l.credit);

-- I3. Stored entry totals must match the sum of their lines
SELECT 'I3 HEADER/LINE MISMATCH' AS violation, e.id, e.reference
FROM journal_entries e
JOIN (SELECT entry_id, sum(debit) d, sum(credit) c
      FROM journal_entry_lines GROUP BY entry_id) l ON l.entry_id = e.id
WHERE e.total_debits <> l.d OR e.total_credits <> l.c;

-- I4. No line may carry both a debit and a credit, or neither
SELECT 'I4 BAD LINE SHAPE' AS violation, id, debit, credit
FROM journal_entry_lines
WHERE (debit > 0 AND credit > 0) OR (debit = 0 AND credit = 0)
   OR debit < 0 OR credit < 0;

-- I5. Accounting equation per company: A = L + E + (Rev - Exp)
SELECT 'I5 EQUATION BROKEN' AS violation, company_id, assets, liab_eq_income
FROM (
  SELECT a.company_id,
    sum(CASE WHEN a.type='asset' THEN l.debit-l.credit ELSE 0 END)::numeric(18,4) assets,
    ( sum(CASE WHEN a.type='liability' THEN l.credit-l.debit ELSE 0 END)
    + sum(CASE WHEN a.type='equity'    THEN l.credit-l.debit ELSE 0 END)
    + sum(CASE WHEN a.type='revenue'   THEN l.credit-l.debit ELSE 0 END)
    - sum(CASE WHEN a.type='expense'   THEN l.debit-l.credit ELSE 0 END))::numeric(18,4) liab_eq_income
  FROM journal_entry_lines l
  JOIN accounts a ON a.id=l.account_id
  JOIN journal_entries e ON e.id=l.entry_id
  WHERE e.status <> 'draft'   -- drafts never reached the ledger (see I6)
  GROUP BY a.company_id
) t WHERE assets <> liab_eq_income;

-- I6. Denormalised account balances must match the ledger (normal-balance aware)
--
-- DRAFTS ARE EXCLUDED, and the audited version of this check did not exclude
-- them. A draft entry has lines but never reaches the ledger: PostingService
-- only touches accounts.balance when status is 'posted'. Counting draft lines
-- against the cached balance reports drift that is not there — five 10.00
-- drafts left by the period-close suite showed up as a 50.00 "imbalance" on
-- Cash and Sales Revenue the first time this gate ran.
--
-- Voided entries ARE counted: their lines stay on file and are offset by a
-- separate reversing entry, which is what keeps the trail auditable.
SELECT 'I6 BALANCE DRIFT' AS violation, a.name, a.type, a.balance stored
FROM accounts a
JOIN journal_entry_lines l ON l.account_id=a.id
JOIN journal_entries e ON e.id=l.entry_id
WHERE e.status <> 'draft'
GROUP BY a.id, a.name, a.type, a.balance
HAVING a.balance <> CASE WHEN a.type IN ('asset','expense')
                         THEN sum(l.debit-l.credit) ELSE sum(l.credit-l.debit) END;

-- I7. Every posted document must carry a journal entry
SELECT 'I7 UNPOSTED INVOICE' AS violation, invoice_number FROM invoices
 WHERE journal_entry_id IS NULL AND status <> 'draft'
UNION ALL SELECT 'I7 UNPOSTED BILL', bill_number FROM bills
 WHERE journal_entry_id IS NULL AND status <> 'draft'
UNION ALL SELECT 'I7 UNPOSTED PAYMENT', id::text FROM payments
 WHERE journal_entry_id IS NULL;

-- I8. Invoice arithmetic: total - paid = balance
SELECT 'I8 INVOICE MATH' AS violation, invoice_number, total, amount_paid, balance
FROM invoices WHERE total - amount_paid <> balance;

-- I9. Status must agree with balance
SELECT 'I9 STATUS/BALANCE' AS violation, invoice_number, status, balance
FROM invoices
WHERE (status='paid' AND balance <> 0) OR (status='sent' AND balance = 0 AND total > 0);

-- I10. Payments may never be over-applied
SELECT 'I10 OVER-APPLIED' AS violation, p.id, p.amount, sum(pa.amount_applied) applied
FROM payments p JOIN payment_applications pa ON pa.payment_id=p.id
GROUP BY p.id, p.amount HAVING sum(pa.amount_applied) > p.amount;

-- I11. Stock may never go negative
SELECT 'I11 NEGATIVE STOCK' AS violation, sku, name, quantity_on_hand
FROM inventory_items WHERE quantity_on_hand < 0;

-- I12. Nothing may be BACK-DATED into a closed period.
--
-- The audited form of this check was:
--
--   WHERE books_locked_until IS NOT NULL
--     AND e.date <= c.books_locked_until AND e.status = 'posted'
--
-- which matches every entry legitimately posted BEFORE the close. Closing one
-- demo company through a month end flagged 40 of its 47 entries. It only ever
-- "passed" because no company had a lock set.
--
-- What it means to catch is back-dating, so compare against the moment the
-- lock was applied (companies.books_locked_at, added for this purpose): an
-- entry dated inside a shut period that was WRITTEN after the period shut.
SELECT 'I12 BACK-DATED INTO CLOSED PERIOD' AS violation,
       e.reference, e.date, c.books_locked_until, e.created_at, c.books_locked_at
FROM journal_entries e JOIN companies c ON c.id=e.company_id
WHERE c.books_locked_until IS NOT NULL
  AND c.books_locked_at IS NOT NULL
  AND e.date <= c.books_locked_until
  AND e.created_at > c.books_locked_at
  AND e.status='posted';

-- I13. Inventory subledger must tie to its control account (1200).
--
-- Catches any path that moves the GL by one amount while moving
-- qty x unit_cost by another — how freezing the credit-memo restock cost was
-- caught breaking the weighted average.
--
-- The tolerance is the ARITHMETIC BOUND of the representation, not a fudge
-- factor. Valuation is quantity x an average stored to 4 decimal places, so
-- each item can be off by at most qty/2 x 10^-4 from the exact running value
-- the GL holds. Summed over the company that is SUM(qty) * 0.00005, plus a
-- cent of slack for the GL's own 4dp rounding. Anything beyond that is a real
-- defect, not rounding.
SELECT 'I13 INVENTORY SUBLEDGER DRIFT' AS violation,
       company_id, gl, valuation, (gl - valuation) AS drift, tolerance
FROM (
  SELECT a.company_id,
         (SELECT COALESCE(SUM(l2.debit - l2.credit), 0)
            FROM journal_entry_lines l2 JOIN accounts a2 ON a2.id = l2.account_id
           WHERE a2.company_id = a.company_id AND a2.account_number = '1200')::numeric(18,4) AS gl,
         (SELECT COALESCE(SUM(quantity_on_hand * unit_cost), 0)
            FROM inventory_items i WHERE i.company_id = a.company_id)::numeric(18,4) AS valuation,
         (SELECT COALESCE(SUM(quantity_on_hand), 0) * 0.00005 + 0.01
            FROM inventory_items i WHERE i.company_id = a.company_id)::numeric(18,6) AS tolerance
  FROM accounts a GROUP BY a.company_id
) t WHERE abs(gl - valuation) > tolerance;

-- I14. No cross-company leakage: every line's account must belong to the same
-- company as its entry.
SELECT 'I14 CROSS-COMPANY LEAK' AS violation, e.id AS entry_id,
       e.company_id AS entry_company, a.company_id AS account_company
FROM journal_entry_lines l
JOIN journal_entries e ON e.id = l.entry_id
JOIN accounts a ON a.id = l.account_id
WHERE a.company_id <> e.company_id;

-- I15. Goods in Transit (1250) must be a way-station, not a resting place.
--
-- Dispatch moves stock Dr 1250 / Cr 1200 at the frozen cost; approval relieves
-- it Dr COGS + Dr 1200 / Cr 1250, and rejection reverses it Dr 1200 / Cr 1250.
-- Either way, once a delivery is resolved its net effect on 1250 is zero. A
-- non-zero residue means a delivery was half-posted -- the goods left inventory
-- and never arrived anywhere, which no other invariant detects because each
-- individual entry still balances on its own.
--
-- Read from general_ledger, which is the table carrying source_id (journal
-- entries themselves do not).
SELECT 'I15 GOODS IN TRANSIT RESIDUE' AS violation,
       t.company_id, t.delivery_id, t.ledger_status, t.residue
FROM (
  SELECT d.id AS delivery_id, d.company_id, d.ledger_status,
         (SELECT COALESCE(SUM(g.debit - g.credit), 0)
            FROM general_ledger g
            JOIN accounts a ON a.id = g.account_id
           WHERE g.source_id = d.id
             AND g.company_id = d.company_id
             AND a.account_number = '1250')::numeric(18,4) AS residue
    FROM deliveries d
   WHERE d.ledger_status IN ('committed', 'returned')
) t
WHERE abs(t.residue) > 0.01;

-- I16. A delivery approval line's closing shelf figure must be arithmetically
-- reachable from its own opening figure.
--
-- `after_qty` is not decoration: stock reports read it as the closing warehouse
-- quantity for that item at that moment. Under the Goods-in-Transit flow the
-- dispatched units left on-hand at assignment, so approval only puts the
-- returns back (`before + returned`); a request that was never applied left
-- the shelf exactly where it was (`before`). Subtracting the delivered units
-- from a figure that already excludes them removes the same goods twice, and
-- nothing else catches it -- the ledger still balances, because this column
-- posts nothing.
--
-- Legacy pre-GIT deliveries (stock_committed_at IS NULL) never moved stock at
-- assignment, so `before - delivered + returned` is correct for them.
SELECT 'I16 DELIVERY AFTER_QTY UNREACHABLE' AS violation,
       r.company_id, r.id AS request_id, r.status, l.item_name,
       l.before_qty, l.delivered_qty, l.returned_qty, l.after_qty,
       CASE
         WHEN d.stock_committed_at IS NULL THEN l.before_qty - l.delivered_qty + l.returned_qty
         WHEN r.status = 'approved' THEN l.before_qty + l.returned_qty
         ELSE l.before_qty
       END AS expected_after_qty
FROM inventory_update_request_lines l
JOIN inventory_update_requests r ON r.id = l.request_id
LEFT JOIN deliveries d ON d.id = r.delivery_id
WHERE abs(l.after_qty - CASE
        WHEN d.stock_committed_at IS NULL THEN l.before_qty - l.delivered_qty + l.returned_qty
        WHEN r.status = 'approved' THEN l.before_qty + l.returned_qty
        ELSE l.before_qty
      END) > 0.0001;

-- I17. A delivery that has stopped moving must have a settled ledger status.
--
-- I15 only inspects deliveries whose ledger_status is already 'committed' or
-- 'returned', so a delivery stuck at 'in_transit' is invisible to it -- which
-- is exactly the state produced when a rejection posted its reversal but the
-- status write was lost. Those deliveries are the ones most likely to be
-- wrong, and nothing was watching them.
--
-- Terminal delivery statuses (delivered / returned / cancelled / failed) mean
-- the goods are no longer in flight, so the ledger must have been settled too.
SELECT 'I17 DELIVERY LEDGER STATUS UNSETTLED' AS violation,
       d.company_id, d.reference_no, d.status, d.ledger_status
FROM deliveries d
WHERE d.status IN ('delivered', 'returned', 'cancelled', 'failed')
  AND d.stock_committed_at IS NOT NULL
  AND d.ledger_status NOT IN ('committed', 'returned');

-- I18. Goods Received Not Invoiced (2050) must clear once the goods are billed.
--
-- The supplier-side twin of I15, and it was missing.
--
-- Receiving a purchase order accrues Dr Inventory / Cr GRNI: the stock is on
-- the shelf and we owe the supplier "something", but no bill has arrived. The
-- bill is what settles it, Dr GRNI / Cr Accounts Payable, so once a PO has
-- been billed its net effect on 2050 is zero.
--
-- A residue means the goods were received and then billed some OTHER way --
-- most likely a bill raised from the Bills form rather than "Convert to Bill",
-- which debits the line's own account instead of GRNI. That leaves 2050 as a
-- liability that never goes away AND, if the line pointed at Inventory, debits
-- the same stock twice. No other invariant sees it: every entry balances on
-- its own, and the inventory subledger (I13) ties to a control account that is
-- itself overstated, so it agrees with the wrong number.
--
-- Only fully-received POs are judged. A partially received one is expected to
-- carry a balance -- that is what the account is for.
--
-- Both legs must be counted, and they are tagged differently: the receipt's
-- credit carries the PO's id, the bill's clearing debit carries the BILL's.
-- Matching only on source_id = po.id sees the credit and never the debit, so
-- it reported a full-value residue on every PO that reached it -- which it did
-- against production, on books where 2050 nets to exactly zero. A check that
-- cannot pass is worse than no check: it trains you to ignore the one thing
-- that would tell you the ledger is wrong.
SELECT 'I18 GRNI RESIDUE ON BILLED PO' AS violation,
       t.company_id, t.po_number, t.residue
FROM (
  SELECT po.id, po.company_id, po.po_number,
         (SELECT COALESCE(SUM(g.debit - g.credit), 0)
            FROM general_ledger g
            JOIN accounts a ON a.id = g.account_id
           WHERE g.company_id = po.company_id
             AND a.account_number = '2050'
             AND (g.source_id = po.id
                  OR g.source_id IN (SELECT b2.id FROM bills b2
                                      WHERE b2.purchase_order_id = po.id
                                        AND b2.status <> 'void'))
         )::numeric(18,4) AS residue
    FROM purchase_orders po
   WHERE po.status IN ('fully_received', 'closed')
     AND EXISTS (SELECT 1 FROM bills b
                  WHERE b.purchase_order_id = po.id
                    AND b.status <> 'void')
) t
WHERE abs(t.residue) > 0.01;
