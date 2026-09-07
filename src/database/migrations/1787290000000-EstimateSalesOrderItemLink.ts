import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Carry the inventory item from the quote all the way to the ledger.
 *
 * Invoice lines have had `item_id` since the beginning — it is what drives the
 * COGS posting and the stock movement when an invoice posts. Estimate and
 * sales-order lines never had it, so the item a user picked was lost the moment
 * they quoted it, and the three conversion paths (estimate -> invoice,
 * estimate -> sales order, sales order -> invoice) rebuilt lines from
 * description and price alone. An invoice converted from an estimate therefore
 * posted no COGS and moved no stock, while the same invoice raised directly did
 * both. These two columns are what closes that.
 *
 * Nullable, with no backfill. Every line written before this had no item to
 * record, and there is no honest way to infer one from a description -- the
 * gap is better left visible than guessed at. Service lines keep it null
 * forever, which is also how invoice lines behave.
 *
 * No foreign key to inventory_items, matching `account_id` beside it and the
 * id-plus-company-scope convention used throughout the codebase. The consumer
 * (InvoicesService.postInvoiceCogs) already looks the item up by id AND
 * company and skips a miss, so a stale id is inert rather than dangerous --
 * and a quote should still record what was quoted after the item is retired.
 */
export class EstimateSalesOrderItemLink1787290000000 implements MigrationInterface {
  name = 'EstimateSalesOrderItemLink1787290000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "estimate_line_items"
        ADD COLUMN IF NOT EXISTS "item_id" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "sales_order_line_items"
        ADD COLUMN IF NOT EXISTS "item_id" uuid
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "estimate_line_items"
        DROP COLUMN IF EXISTS "item_id"
    `);
    await queryRunner.query(`
      ALTER TABLE "sales_order_line_items"
        DROP COLUMN IF EXISTS "item_id"
    `);
  }
}
