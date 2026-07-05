import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Chunk 2: delivery approvals now post Dr COGS / Cr Inventory when stock is
 * committed; the request keeps a link to its journal entry so an undo can
 * post the exact reversal. Additive + idempotent.
 */
export class ApprovalJournalLink1783730000000 implements MigrationInterface {
  name = 'ApprovalJournalLink1783730000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_update_requests"
        ADD COLUMN IF NOT EXISTS "journal_entry_id" uuid
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_update_requests"
        DROP COLUMN IF EXISTS "journal_entry_id"
    `);
  }
}
