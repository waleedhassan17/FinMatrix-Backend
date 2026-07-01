import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FinMatrix.md §11 — credit-memo inventory restock. Adds an optional item_id to
 * credit_memo_lines so a returned inventory item can be tied back to stock:
 * on a credit memo the goods come back in (Dr Inventory / Cr COGS, qty↑),
 * mirroring the invoice cost side (added in 1782600000000). Idempotent.
 */
export class CreditMemoLineItemId1783300000000 implements MigrationInterface {
  name = 'CreditMemoLineItemId1783300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "credit_memo_lines"
        ADD COLUMN IF NOT EXISTS "item_id" uuid
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "credit_memo_lines" DROP COLUMN IF EXISTS "item_id"
    `);
  }
}
