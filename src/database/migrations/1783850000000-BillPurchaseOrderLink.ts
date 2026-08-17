import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Link a bill back to the purchase order it was created from, and make that
 * link exclusive.
 *
 * Converting a received PO to a bill posts DR GRNI / CR AP, clearing the GRNI
 * raised at receipt. Doing it twice posts that entry twice: AP is overstated
 * by the value of the goods and GRNI is driven negative, while the vendor is
 * only owed once. Nothing prevented it — `create-bill` had no guard, bills
 * carried no reference to their PO, and `bill_number` is not unique — so the
 * only evidence was a free-text memo.
 *
 * The UNIQUE index is what makes this airtight rather than merely unlikely: a
 * service-level "does a bill already exist" check can be lost between two
 * concurrent requests, but the index cannot. NULL is not distinct-equal in
 * Postgres, so ordinary (non-PO) bills are unaffected however many there are.
 *
 * Additive and idempotent; existing rows keep NULL and nothing is rewritten.
 */
export class BillPurchaseOrderLink1783850000000 implements MigrationInterface {
  name = 'BillPurchaseOrderLink1783850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "bills"
        ADD COLUMN IF NOT EXISTS "purchase_order_id" uuid NULL
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "UQ_bills_purchase_order_id"
        ON "bills" ("purchase_order_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "UQ_bills_purchase_order_id"`);
    await queryRunner.query(`ALTER TABLE "bills" DROP COLUMN IF EXISTS "purchase_order_id"`);
  }
}
