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
