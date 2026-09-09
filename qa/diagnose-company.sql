-- ═══════════════════════════════════════════════════════════════════
-- FinMatrix — why is nothing showing in the General Ledger / Reports?
--
-- Unlike qa/invariants.sql, this file is INFORMATIONAL, not a gate. Every
-- query prints something; you read the numbers and decide. It answers one
-- question for one company:
--
--     "are the books empty, or am I just looking at the wrong window?"
--
-- Run it BEFORE changing any code. It takes 30 seconds and tells you which
-- of the three explanations you are actually looking at:
--
--   A. Nothing was ever posted        -> section 1 shows 0 posted entries
--   B. Something posted, but outside  -> section 1 shows entries whose date
--      the range the screen asked for    range does not overlap the report
--   C. A flow is silently failing     -> sections 3-6 name the documents
--
-- Deliberately NOT duplicated here: "a posted document with no journal
-- entry". qa/invariants.sql check I7 already covers invoices, bills and
-- payments across every company, and it fails the build. Run that too:
--
--     npm run test:qa
--
-- Usage:
--
--   docker exec -i finmatrix-postgres psql -U finmatrix_user -d finmatrix \
--     -v companyId="'<uuid>'" -f qa/diagnose-company.sql
--
--   psql "$DATABASE_URL" -v companyId="'<uuid>'" -f qa/diagnose-company.sql
--
-- Note the DOUBLE quoting on companyId: psql substitutes :companyId
-- literally, so the value has to arrive carrying its own SQL quotes.
--
-- Every statement is a SELECT. This file never writes.
-- ═══════════════════════════════════════════════════════════════════

\echo ''
\echo '=== 0. Which company am I looking at? ============================='
SELECT id, name, created_at::date AS created, books_locked_until
FROM companies WHERE id = :companyId;

\echo ''
\echo '=== 1. Is there anything in the books at all? ====================='
-- The single most important table. `posted` is the only status that reaches
-- the general ledger: a draft entry has lines but never moves an account
-- balance, which is a supported working state, not a defect.
--
-- Read `first_entry`/`last_entry` against the date range your report screen
-- asked for. A P&L for this year over books that stop in November of last
-- year is CORRECTLY empty -- that is explanation B, not a bug.
SELECT status,
       count(*)   AS entries,
       min(date)  AS first_entry,
       max(date)  AS last_entry
FROM journal_entries
WHERE company_id = :companyId
GROUP BY status
ORDER BY status;

\echo ''
\echo '=== 2. Did every posted line reach the ledger? ===================='
-- PostingService writes journal_entry_lines and general_ledger in the same
-- transaction, so these two counts must be EQUAL. A gap means a posting was
-- interrupted between the two writes, and the statements (which read
-- general_ledger, never the document tables) will under-report.
--
-- VOID entries are counted on both sides deliberately. Voiding does not
-- delete anything: the original lines and their ledger rows stay on file and
-- are cancelled by a separate reversing entry, which is what keeps the trail
-- auditable. Excluding them from the left side alone reports a gap that is
-- not there -- on Warehouse Co that was 26 voided entries showing up as a
-- phantom 52-row shortfall. DRAFT entries are excluded from both: they have
-- lines but never reach the ledger.
SELECT (SELECT count(*)
          FROM journal_entry_lines l
          JOIN journal_entries e ON e.id = l.entry_id
         WHERE e.company_id = :companyId
           AND e.status IN ('posted', 'void'))                    AS ledger_bound_lines,
       (SELECT count(*)
          FROM general_ledger
         WHERE company_id = :companyId)                           AS gl_rows;

\echo ''
\echo '=== 3. Deliveries: how far did each one get? ======================'
-- Revenue on a delivery is recognised at ADMIN APPROVAL, never at dispatch.
-- That is the flow working as designed (IFRS 15 / ASC 606: control transfers
-- on delivery), so:
--
--   ledger_status = 'in_transit'  -> dispatched, NOT yet approved.
--                                    Dr Goods in Transit / Cr Inventory only.
--                                    NO revenue, NO COGS. An empty P&L here
--                                    is CORRECT -- nothing is sold yet.
--                                    ** This is the usual answer to
--                                    "I delivered stock and saw nothing." **
--   ledger_status = 'committed'   -> approved; revenue + COGS have posted.
--   ledger_status = 'returned'    -> rejected; stock went back on the shelf.
--
-- A large in_transit count means deliveries are piling up waiting for the
-- owner to sign them off, not that the ledger is broken.
SELECT ledger_status, status, count(*)
FROM deliveries
WHERE company_id = :companyId
GROUP BY ledger_status, status
ORDER BY ledger_status, status;

\echo ''
\echo '=== 4. Approved deliveries that produced no sale =================='
-- A delivery that reached 'committed' must carry an invoice with a non-zero
-- total. A row here is a real defect: the stock left the shelf and the books
-- recorded no revenue for it.
SELECT d.reference_no, d.completed_at::date AS approved_on,
       d.invoice_id, i.invoice_number, i.total,
       CASE WHEN d.invoice_id IS NULL THEN 'no invoice raised'
            ELSE 'invoice totals zero' END AS problem
FROM deliveries d
LEFT JOIN invoices i ON i.id = d.invoice_id
WHERE d.company_id = :companyId
  AND d.ledger_status = 'committed'
  AND (d.invoice_id IS NULL OR i.total::numeric = 0)
ORDER BY d.completed_at DESC NULLS LAST;

\echo ''
\echo '=== 5. Unpriced lines on deliveries still awaiting approval ======='
-- The approval landmine. A delivery line carries the price COPIED from the
-- inventory item at the moment it was added to the draft; the backend does
-- not look the price up again. If EVERY line on a delivery is priced zero,
-- approval tries to raise a zero-total invoice, whose A/R line would be
-- `debit 0 / credit 0` -- rejected by the posting engine AND by the
-- chk_line_shape database constraint. The delivery then sticks at
-- 'in_transit' forever.
--
-- A zero-price line MIXED with a priced one is fine and intentional: that is
-- how a free sample ships alongside a paid order. Only `all_lines_unpriced`
-- is a blocker.
SELECT d.reference_no,
       d.ledger_status,
       count(*)                                                   AS lines,
       count(*) FILTER (WHERE di.unit_price::numeric = 0)         AS unpriced_lines,
       bool_and(di.unit_price::numeric = 0)                       AS all_lines_unpriced,
       string_agg(di.item_name, ', ')
         FILTER (WHERE di.unit_price::numeric = 0)                AS unpriced_items
FROM deliveries d
JOIN delivery_items di ON di.delivery_id = d.id
WHERE d.company_id = :companyId
  -- Only deliveries that can still BE approved. 'committed' already posted;
  -- 'returned' was rejected and its stock is back on the shelf. Including
  -- either lists finished work as though it were stuck, and the noise buries
  -- the rows that matter.
  AND d.ledger_status IN ('none', 'in_transit')
  AND di.quantity::numeric > 0
GROUP BY d.id, d.reference_no, d.ledger_status
HAVING count(*) FILTER (WHERE di.unit_price::numeric = 0) > 0
ORDER BY all_lines_unpriced DESC, d.reference_no;

\echo ''
\echo '=== 6. Inventory items with no selling price ====================='
-- The upstream cause of section 5. inventory_items.selling_price DEFAULTS to
-- 0, so an item created by import, by the agency add-item form, or by the API
-- can carry no price at all. Anything delivered from such an item arrives on
-- the delivery line at 0.
SELECT sku, name, unit_cost, selling_price, quantity_on_hand
FROM inventory_items
WHERE company_id = :companyId AND selling_price::numeric = 0
ORDER BY name;

\echo ''
\echo '=== 7. Deliveries on the legacy approval path ====================='
-- stock_committed_at is set when a delivery is dispatched under the
-- Goods-in-Transit flow. A delivery still awaiting approval WITHOUT it
-- predates that flow and takes applyLegacyApproval, which posts
-- Dr COGS / Cr Inventory and raises NO INVOICE -- so approving it books the
-- cost with no matching revenue.
--
-- Expect zero rows on a company created after the Goods-in-Transit flow
-- shipped. Any row here needs handling by hand before it is approved.
SELECT reference_no, status, ledger_status, created_at::date AS created
FROM deliveries
WHERE company_id = :companyId
  AND stock_committed_at IS NULL
  AND status NOT IN ('cancelled', 'returned')
ORDER BY created_at DESC;

\echo ''
\echo '=== 8. Draft documents (correctly absent from the books) =========='
-- A draft posts no journal entry. That is correct accounting, not a bug --
-- but it is also invisible in every report, so a user who saved a document
-- as a draft and expected it "in the books" will see nothing. Counts here
-- explain that gap without implying a defect.
SELECT 'invoices' AS document, count(*) AS drafts
  FROM invoices WHERE company_id = :companyId AND status = 'draft'
UNION ALL SELECT 'bills', count(*)
  FROM bills WHERE company_id = :companyId AND status = 'draft'
ORDER BY document;

\echo ''
\echo '=== Done. See qa/DIAGNOSIS.md for how to read this. =============='
