import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Who raised a purchase order, so Day Summary can credit it in Team activity
 * and show it in a staff member's own day.
 *
 * Schema (additive):
 *  - purchase_orders.created_by: nullable. Purchase orders raised before this
 *    migration (and any the previous release writes while a deploy is rolling)
 *    stay NULL and show as "Not recorded", exactly as they did before.
 *  - (company_id, order_date): Day Summary reads purchase orders by their own
 *    date, like the indexes 1791200000000 added for the other documents.
 *
 * Re-runnable: every statement is guarded.
 */
export class PurchaseOrderCreator1791300000000 implements MigrationInterface {
  name = 'PurchaseOrderCreator1791300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" ADD COLUMN IF NOT EXISTS "created_by" uuid NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_purchase_orders_company_order_date"
         ON "purchase_orders" ("company_id", "order_date")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_purchase_orders_company_order_date"`,
    );
    await queryRunner.query(
      `ALTER TABLE "purchase_orders" DROP COLUMN IF EXISTS "created_by"`,
    );
  }
}
