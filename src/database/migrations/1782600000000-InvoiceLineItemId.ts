import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 2b — link invoice lines to inventory items so issuing an invoice can
 * post the COGS/Inventory cost entry and relieve stock (FinMatrixGuide §3.1).
 * The column is nullable: existing free-text/service lines keep working and
 * post no cost. Idempotent.
 */
export class InvoiceLineItemId1782600000000 implements MigrationInterface {
  name = 'InvoiceLineItemId1782600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "invoice_line_items"
        ADD COLUMN IF NOT EXISTS "item_id" uuid
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "invoice_line_items"
        DROP COLUMN IF EXISTS "item_id"
    `);
  }
}
