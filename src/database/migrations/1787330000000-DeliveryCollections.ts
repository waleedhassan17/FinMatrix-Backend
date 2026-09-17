import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * What a delivery's customer paid, and when.
 *
 * 1. deliveries.advance_amount / advance_payment_id — money taken before the
 *    goods leave. It used to be a bare Dr Cash / Cr 2400 journal posted at
 *    dispatch with no receipt behind it, so the advance never appeared among
 *    the customer's receipts: whatever a partial delivery or a rejection left
 *    of it sat in 2400 with nothing in the app able to apply or refund it. New
 *    advances are real receipts (RCT) held as customer advances; the id links
 *    the delivery to that receipt. advance_amount may be less than the order,
 *    in which case the rider collects the balance.
 *
 * 2. deliveries.amount_collected — what the rider took at the door, as settled
 *    at approval (the owner's cash count wins over the rider's figure).
 *    paid_status gains 'partial', which varchar(8) already holds.
 *
 * 3. inventory_update_requests.paid_status / amount_collected — the rider's own
 *    claim, kept on the request so a corrected cash count stays auditable.
 *
 * Backfill: legacy prepaid deliveries get advance_amount from the bare advance
 * journal they posted, for display only. No journal is rewritten, and
 * advance_payment_id stays NULL — which is what keeps them on the legacy
 * release path at approval.
 *
 * Additive and repeatable.
 */
export class DeliveryCollections1787330000000 implements MigrationInterface {
  name = 'DeliveryCollections1787330000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "deliveries"
        ADD COLUMN IF NOT EXISTS "advance_amount" numeric(18,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "advance_payment_id" uuid NULL,
        ADD COLUMN IF NOT EXISTS "amount_collected" numeric(18,4) NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_deliveries_advance_payment"
        ON "deliveries" ("advance_payment_id")
        WHERE "advance_payment_id" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_update_requests"
        ADD COLUMN IF NOT EXISTS "paid_status" varchar(8) NULL,
        ADD COLUMN IF NOT EXISTS "amount_collected" numeric(18,4) NULL
    `);
    await queryRunner.query(`
      UPDATE "deliveries" d
         SET "advance_amount" = gl.amount
        FROM (SELECT source_id, SUM(credit) AS amount
                FROM general_ledger
               WHERE source_type = 'delivery_advance' AND credit > 0
               GROUP BY source_id) gl
       WHERE gl.source_id = d.id
         AND d.prepaid = true
         AND d.advance_payment_id IS NULL
         AND d.advance_amount = 0
    `);
    // An approved delivery's paid_status is display state derived from its
    // invoice (payments.refreshDeliveryPaidStatus). It used to flip only on
    // full settlement, so a part-paid invoice kept reading 'unpaid'. Bring
    // every committed row into line; nothing posts from this column once the
    // ledger is committed.
    await queryRunner.query(`
      UPDATE "deliveries" d
         SET "paid_status" = CASE WHEN i.balance <= 0.0001 THEN 'paid'
                                  WHEN i.amount_paid > 0.0001 THEN 'partial'
                                  ELSE 'unpaid' END
        FROM invoices i
       WHERE i.id = d.invoice_id
         AND d.ledger_status = 'committed'
         AND i.status NOT IN ('void', 'draft')
         -- Credited, not paid: a reversed sale is not "paid".
         AND NOT EXISTS (SELECT 1 FROM credit_memo_applications cma WHERE cma.invoice_id = i.id)
         AND NOT EXISTS (SELECT 1 FROM credit_memos cm WHERE cm.original_invoice_id = i.id AND cm.status <> 'void')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_update_requests"
        DROP COLUMN IF EXISTS "amount_collected",
        DROP COLUMN IF EXISTS "paid_status"
    `);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_deliveries_advance_payment"`);
    await queryRunner.query(`
      ALTER TABLE "deliveries"
        DROP COLUMN IF EXISTS "amount_collected",
        DROP COLUMN IF EXISTS "advance_payment_id",
        DROP COLUMN IF EXISTS "advance_amount"
    `);
  }
}
