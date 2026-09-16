import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Schema for the QA fixes to numbering, customer advances and purchase billing.
 *
 * 1. document_sequences — the last number issued per company, series and year.
 *    Numbers used to be COUNT(*)+1 over the document table, which handed out a
 *    number again after a hard delete. Backfilled from the highest number each
 *    series has already issued, so nothing collides with history.
 *
 * 2. payments.payment_number (RCT-YYYY-NNNN) — receipts had no number at all;
 *    the clients invented PMT-<uuid>. Backfilled in date order.
 *    payments.advance_posted — whether the unapplied part of a receipt was
 *    credited to 2400 Customer Advances (new receipts) or, as before, left as a
 *    credit inside 1100 Accounts Receivable (every existing row: false). Applying
 *    a receipt's remainder later posts Dr 2400 / Cr 1100 only when it is true.
 *
 * 3. payment_applications.applied_on / journal_entry_id — an application made
 *    after the receipt (applying an advance) carries its own date and entry.
 *    NULL on both means "applied inside the receipt's own entry", which is every
 *    existing row.
 *
 * 4. purchase_order_lines.billed_qty / grni_accrued / grni_cleared and
 *    bill_line_items.purchase_order_line_id / quantity / grni_amount — a PO can
 *    now be billed once per receipt instead of once in its life. GRNI is tracked
 *    per line so each bill clears exactly what that line's receipts accrued.
 *    The UNIQUE index that enforced one bill per PO is replaced by a plain one.
 *    Backfilled from the single bill each PO could have had: its lines were
 *    written with the PO line's description and received_qty × unit_cost.
 *
 * Additive and repeatable (IF NOT EXISTS / guarded backfills).
 */
export class QaFixesSchema1787320000000 implements MigrationInterface {
  name = 'QaFixesSchema1787320000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. document_sequences ─────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "document_sequences" (
        "company_id" uuid NOT NULL,
        "doc_type" varchar(16) NOT NULL,
        "year" integer NOT NULL,
        "last_value" integer NOT NULL DEFAULT 0,
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "PK_document_sequences" PRIMARY KEY ("company_id", "doc_type", "year")
      )
    `);

    // ── 2. payments ───────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "payments"
        ADD COLUMN IF NOT EXISTS "payment_number" varchar(32) NULL,
        ADD COLUMN IF NOT EXISTS "advance_posted" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      WITH existing AS (
        SELECT company_id,
               CAST(substring(payment_number FROM '^RCT-([0-9]{4})-') AS integer) AS yr,
               MAX(CAST(substring(payment_number FROM '[0-9]+$') AS integer)) AS top
          FROM payments
         WHERE payment_number ~ '^RCT-[0-9]{4}-[0-9]+$'
         GROUP BY 1, 2
      ),
      numbered AS (
        SELECT p.id,
               p.company_id,
               CAST(EXTRACT(YEAR FROM p.payment_date) AS integer) AS yr,
               ROW_NUMBER() OVER (
                 PARTITION BY p.company_id, EXTRACT(YEAR FROM p.payment_date)
                 ORDER BY p.payment_date, p.created_at, p.id
               ) AS rn
          FROM payments p
         WHERE p.payment_number IS NULL
      )
      UPDATE payments p
         SET payment_number = 'RCT-' || n.yr || '-' ||
             LPAD(CAST(n.rn + COALESCE(e.top, 0) AS text), 4, '0')
        FROM numbered n
        LEFT JOIN existing e ON e.company_id = n.company_id AND e.yr = n.yr
       WHERE p.id = n.id
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_payments_company_payment_number"
        ON "payments" ("company_id", "payment_number")
    `);

    // ── 3. payment_applications ───────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "payment_applications"
        ADD COLUMN IF NOT EXISTS "applied_on" date NULL,
        ADD COLUMN IF NOT EXISTS "journal_entry_id" uuid NULL
    `);

    // ── 4. purchase billing per receipt ───────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "purchase_order_lines"
        ADD COLUMN IF NOT EXISTS "billed_qty" numeric(18,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "grni_accrued" numeric(18,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "grni_cleared" numeric(18,4) NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "bill_line_items"
        ADD COLUMN IF NOT EXISTS "purchase_order_line_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "quantity" numeric(18,4) NULL,
        ADD COLUMN IF NOT EXISTS "grni_amount" numeric(18,4) NULL
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_bills_purchase_order_id"`);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_bills_purchase_order_id"
        ON "bills" ("purchase_order_id")
    `);

    // Receipts so far accrued GRNI at net cost (received_qty × unit_cost).
    await queryRunner.query(`
      UPDATE purchase_order_lines
         SET grni_accrued = ROUND(received_qty * unit_cost, 4)
       WHERE item_id IS NOT NULL
         AND grni_accrued = 0
         AND received_qty > 0
    `);

    // Link each existing PO bill's lines to the PO lines they billed. Matched by
    // description, and by position among equal descriptions.
    await queryRunner.query(`
      WITH po_lines AS (
        SELECT pol.id, pol.order_id, pol.description, pol.unit_cost, pol.received_qty,
               pol.item_id,
               ROW_NUMBER() OVER (PARTITION BY pol.order_id, pol.description ORDER BY pol.line_order, pol.id) AS rk
          FROM purchase_order_lines pol
      ),
      bill_lines AS (
        SELECT bl.id, b.purchase_order_id AS order_id, bl.description, bl.amount, bl.tax_amount,
               b.company_id,
               ROW_NUMBER() OVER (PARTITION BY b.id, bl.description ORDER BY bl.line_order, bl.id) AS rk
          FROM bill_line_items bl
          JOIN bills b ON b.id = bl.bill_id
         WHERE b.purchase_order_id IS NOT NULL
           AND bl.purchase_order_line_id IS NULL
      ),
      matched AS (
        SELECT bl.id AS bill_line_id,
               pl.id AS po_line_id,
               pl.item_id,
               CASE WHEN pl.unit_cost > 0
                    THEN LEAST(pl.received_qty, ROUND(bl.amount / pl.unit_cost, 4))
                    ELSE pl.received_qty END AS qty,
               bl.amount
                 + CASE WHEN COALESCE(c.sales_tax_registered, false) THEN 0 ELSE bl.tax_amount END
                 AS grni_debit
          FROM bill_lines bl
          JOIN po_lines pl
            ON pl.order_id = bl.order_id AND pl.description = bl.description AND pl.rk = bl.rk
          LEFT JOIN companies c ON c.id = bl.company_id
      )
      UPDATE bill_line_items bli
         SET purchase_order_line_id = m.po_line_id,
             quantity = m.qty,
             grni_amount = CASE WHEN m.item_id IS NOT NULL THEN m.grni_debit ELSE NULL END
        FROM matched m
       WHERE bli.id = m.bill_line_id
    `);
    await queryRunner.query(`
      UPDATE purchase_order_lines pol
         SET billed_qty = s.qty,
             grni_cleared = CASE WHEN pol.item_id IS NOT NULL THEN s.grni ELSE 0 END
        FROM (
          SELECT purchase_order_line_id AS id,
                 SUM(quantity) AS qty,
                 SUM(COALESCE(grni_amount, 0)) AS grni
            FROM bill_line_items
           WHERE purchase_order_line_id IS NOT NULL
           GROUP BY purchase_order_line_id
        ) s
       WHERE pol.id = s.id
         AND pol.billed_qty = 0
    `);

    // ── 1b. seed document_sequences from every number already issued ───────
    const series: Array<[string, string, string]> = [
      ['INV', 'invoices', 'invoice_number'],
      ['EST', 'estimates', 'estimate_number'],
      ['SO', 'sales_orders', 'order_number'],
      ['PO', 'purchase_orders', 'po_number'],
      ['BILL', 'bills', 'bill_number'],
      ['CM', 'credit_memos', 'credit_memo_number'],
      ['VC', 'vendor_credits', 'vendor_credit_number'],
      ['RCT', 'payments', 'payment_number'],
    ];
    for (const [prefix, table, column] of series) {
      await queryRunner.query(`
        INSERT INTO document_sequences (company_id, doc_type, year, last_value, updated_at)
        SELECT company_id,
               '${prefix}',
               CAST(substring(${column} FROM '^${prefix}-([0-9]{4})-') AS integer),
               MAX(CAST(substring(${column} FROM '[0-9]+$') AS integer)),
               now()
          FROM ${table}
         WHERE ${column} ~ '^${prefix}-[0-9]{4}-[0-9]+$'
         GROUP BY 1, 2, 3
        ON CONFLICT (company_id, doc_type, year)
          DO UPDATE SET last_value = GREATEST(document_sequences.last_value, EXCLUDED.last_value)
      `);
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_bills_purchase_order_id"`);
    await queryRunner.query(`
      ALTER TABLE "bill_line_items"
        DROP COLUMN IF EXISTS "purchase_order_line_id",
        DROP COLUMN IF EXISTS "quantity",
        DROP COLUMN IF EXISTS "grni_amount"
    `);
    await queryRunner.query(`
      ALTER TABLE "purchase_order_lines"
        DROP COLUMN IF EXISTS "billed_qty",
        DROP COLUMN IF EXISTS "grni_accrued",
        DROP COLUMN IF EXISTS "grni_cleared"
    `);
    await queryRunner.query(`
      ALTER TABLE "payment_applications"
        DROP COLUMN IF EXISTS "applied_on",
        DROP COLUMN IF EXISTS "journal_entry_id"
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_payments_company_payment_number"`);
    await queryRunner.query(`
      ALTER TABLE "payments"
        DROP COLUMN IF EXISTS "payment_number",
        DROP COLUMN IF EXISTS "advance_posted"
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "document_sequences"`);
    // The one-bill-per-PO unique index is not restored: once a PO has been
    // billed per receipt it cannot hold, and rolling back must not fail on it.
  }
}
