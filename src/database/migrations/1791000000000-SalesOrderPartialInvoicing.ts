import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Sales orders can be invoiced as their goods ship, in several invoices, and
 * short-closed when the rest will not ship.
 *
 * Before this, converting an order billed every line's FULL ordered quantity
 * and froze the order as 'invoiced': half-shipped orders billed (and took off
 * the books) goods that had not left, and the remainder could never be
 * shipped, invoiced or closed. Voiding the invoice left the order frozen.
 *
 * Schema (additive, no foreign keys — same as bills ↔ purchase orders):
 *  - sales_order_line_items.quantity_invoiced: billed on live invoices.
 *  - invoices.sales_order_id + invoice_line_items.sales_order_line_id: which
 *    order (line) an invoice bills, so a void or delete can give it back.
 *  - invoices.sales_order_auto_shipped: the conversion also recorded the
 *    shipment ("ship and invoice everything"), so a void un-ships it too.
 *  - sales_orders.status may now be 'closed' (varchar(16), no CHECK).
 *
 * Backfill (orders created by a delivery are left alone throughout — the
 * delivery ships and invoices them itself):
 *  1. link each order's invoice (invoices.sales_order_id);
 *  2. link invoice lines to order lines by position (both were written in
 *     line order), checked against description and item;
 *  3. quantity_invoiced = what live linked invoices bill; a line the matcher
 *     missed on a live-invoiced order counts as fully billed, which is what
 *     the old conversion did;
 *  4. orders converted without ever recording a shipment were "ship and
 *     invoice in one step": shipped := invoiced and the invoice is flagged, so
 *     they do not all suddenly ask for a shipment;
 *  5. orders still 'invoiced' whose invoice was voided or deleted become
 *     'closed' with an audit row. Re-opening them automatically could bill
 *     them twice; the owner can reopen any of them deliberately.
 *
 * Re-runnable: every step is guarded.
 */
export class SalesOrderPartialInvoicing1791000000000 implements MigrationInterface {
  name = 'SalesOrderPartialInvoicing1791000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── schema ──────────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "sales_order_line_items"
        ADD COLUMN IF NOT EXISTS "quantity_invoiced" numeric(18,4) NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint
                        WHERE conname = 'CHK_so_line_qty_invoiced_nonneg') THEN
          ALTER TABLE "sales_order_line_items"
            ADD CONSTRAINT "CHK_so_line_qty_invoiced_nonneg"
            CHECK ("quantity_invoiced" >= 0);
        END IF;
      END $$
    `);
    await queryRunner.query(`
      ALTER TABLE "invoices"
        ADD COLUMN IF NOT EXISTS "sales_order_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "sales_order_auto_shipped" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_invoices_sales_order_id"
        ON "invoices" ("sales_order_id")
    `);
    await queryRunner.query(`
      ALTER TABLE "invoice_line_items"
        ADD COLUMN IF NOT EXISTS "sales_order_line_id" uuid NULL
    `);

    // ── 1. link each order's invoice (void ones too, for history) ───────────
    await queryRunner.query(`
      UPDATE invoices i
         SET sales_order_id = o.id
        FROM sales_orders o
       WHERE o.invoice_id = i.id
         AND o.company_id = i.company_id
         AND i.sales_order_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.sales_order_id = o.id)
    `);

    // ── 2. link invoice lines to order lines by position ────────────────────
    await queryRunner.query(`
      WITH so_lines AS (
        SELECT l.id, l.sales_order_id, l.description, l.item_id,
               ROW_NUMBER() OVER (PARTITION BY l.sales_order_id
                                  ORDER BY l.line_order, l.id) AS rk
          FROM sales_order_line_items l
         WHERE EXISTS (SELECT 1 FROM invoices i
                        WHERE i.sales_order_id = l.sales_order_id)
      ), inv_lines AS (
        SELECT il.id, i.sales_order_id, il.description, il.item_id,
               ROW_NUMBER() OVER (PARTITION BY il.invoice_id
                                  ORDER BY il.line_order, il.id) AS rk
          FROM invoice_line_items il
          JOIN invoices i ON i.id = il.invoice_id
         WHERE i.sales_order_id IS NOT NULL
      )
      UPDATE invoice_line_items t
         SET sales_order_line_id = s.id
        FROM inv_lines v
        JOIN so_lines s
          ON s.sales_order_id = v.sales_order_id
         AND s.rk = v.rk
         AND s.description = v.description
         AND s.item_id IS NOT DISTINCT FROM v.item_id
       WHERE t.id = v.id
         AND t.sales_order_line_id IS NULL
    `);

    // ── 3. invoiced quantity = what live linked invoices bill ───────────────
    await queryRunner.query(`
      UPDATE sales_order_line_items l
         SET quantity_invoiced = s.qty
        FROM (SELECT il.sales_order_line_id AS id, SUM(il.quantity) AS qty
                FROM invoice_line_items il
                JOIN invoices i ON i.id = il.invoice_id
               WHERE il.sales_order_line_id IS NOT NULL
                 AND i.status <> 'void'
               GROUP BY il.sales_order_line_id) s
       WHERE l.id = s.id
         AND l.quantity_invoiced = 0
    `);
    // Safety net: the old conversion billed every line in full.
    await queryRunner.query(`
      UPDATE sales_order_line_items l
         SET quantity_invoiced = l.quantity
        FROM sales_orders o
        JOIN invoices i ON i.id = o.invoice_id AND i.status <> 'void'
       WHERE l.sales_order_id = o.id
         AND o.status = 'invoiced'
         AND l.quantity_invoiced < l.quantity
         AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.sales_order_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM invoice_line_items il
                          WHERE il.sales_order_line_id = l.id)
    `);

    // ── 4. one-step conversions: shipped := invoiced, flag the invoice ──────
    await queryRunner.query(`
      UPDATE invoices i
         SET sales_order_auto_shipped = true
        FROM sales_orders o
       WHERE i.id = o.invoice_id
         AND i.status <> 'void'
         AND o.status = 'invoiced'
         AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.sales_order_id = o.id)
         AND NOT EXISTS (SELECT 1 FROM sales_order_line_items x
                          WHERE x.sales_order_id = o.id
                            AND x.quantity_fulfilled > 0)
    `);
    await queryRunner.query(`
      UPDATE sales_order_line_items l
         SET quantity_fulfilled = l.quantity_invoiced
        FROM sales_orders o
        JOIN invoices i ON i.id = o.invoice_id
       WHERE l.sales_order_id = o.id
         AND i.sales_order_auto_shipped = true
         AND i.status <> 'void'
         AND o.status = 'invoiced'
         AND l.quantity_fulfilled = 0
    `);

    // ── 5. orders frozen as 'invoiced' with no live invoice → closed ────────
    await queryRunner.query(`
      WITH orphans AS (
        SELECT o.id, o.company_id, o.invoice_id
          FROM sales_orders o
         WHERE o.status = 'invoiced'
           AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.sales_order_id = o.id)
           AND NOT EXISTS (SELECT 1 FROM invoices i
                            WHERE i.sales_order_id = o.id AND i.status <> 'void')
           AND NOT EXISTS (SELECT 1 FROM invoices i
                            WHERE i.id = o.invoice_id AND i.status <> 'void')
      ), closed AS (
        UPDATE sales_orders o
           SET status = 'closed', invoice_id = NULL, updated_at = now()
          FROM orphans x
         WHERE o.id = x.id
        RETURNING o.id, o.company_id, x.invoice_id AS old_invoice_id
      )
      INSERT INTO operational_audit_events
             (company_id, actor_user_id, action, target_type, target_id, details)
      SELECT c.company_id, NULL, 'sales_order_status_backfilled', 'sales_order',
             c.id::text,
             jsonb_build_object(
               'from', 'invoiced', 'to', 'closed',
               'reason', 'Its invoice was voided or deleted before partial invoicing existed.',
               'invoiceId', c.old_invoice_id,
               'source', 'migration/1791000000000')
        FROM closed c
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The old code would bill a partly invoiced order again in full: freeze
    // those as invoiced.
    await queryRunner.query(`
      UPDATE sales_orders o SET status = 'invoiced'
       WHERE o.status IN ('open', 'partial', 'fulfilled', 'closed')
         AND EXISTS (SELECT 1 FROM sales_order_line_items l
                      WHERE l.sales_order_id = o.id AND l.quantity_invoiced > 0)
    `);
    // Orders closed by up() go back exactly as they were.
    await queryRunner.query(`
      UPDATE sales_orders o
         SET status = 'invoiced',
             invoice_id = NULLIF(e.details->>'invoiceId', '')::uuid
        FROM operational_audit_events e
       WHERE e.action = 'sales_order_status_backfilled'
         AND e.target_type = 'sales_order'
         AND e.target_id = o.id::text
         AND o.status = 'closed'
    `);
    await queryRunner.query(`
      DELETE FROM operational_audit_events
       WHERE action = 'sales_order_status_backfilled'
    `);
    // The old code has no 'closed'.
    await queryRunner.query(
      `UPDATE sales_orders SET status = 'cancelled' WHERE status = 'closed'`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_invoices_sales_order_id"`,
    );
    await queryRunner.query(`
      ALTER TABLE "invoices"
        DROP COLUMN IF EXISTS "sales_order_id",
        DROP COLUMN IF EXISTS "sales_order_auto_shipped"
    `);
    await queryRunner.query(
      `ALTER TABLE "invoice_line_items" DROP COLUMN IF EXISTS "sales_order_line_id"`,
    );
    await queryRunner.query(`
      ALTER TABLE "sales_order_line_items"
        DROP CONSTRAINT IF EXISTS "CHK_so_line_qty_invoiced_nonneg"
    `);
    await queryRunner.query(
      `ALTER TABLE "sales_order_line_items" DROP COLUMN IF EXISTS "quantity_invoiced"`,
    );
    // Step 4's shipped := invoiced is kept: harmless, the old fulfill()
    // refuses invoiced orders.
  }
}
