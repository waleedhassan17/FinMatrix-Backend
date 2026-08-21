import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record which account an inventory adjustment offset Inventory (1200) against.
 *
 * The adjustment reason used to be decorative: damage, theft, obsolescence and
 * a count variance all posted to 6400, so the P&L could not tell them apart.
 * The reason now selects a 54xx shrinkage account, which means the account is
 * no longer derivable from the row — two adjustments with the same reason can
 * legitimately sit in different accounts if the mapping changes between them.
 *
 * More pressing: reverseAdjustment() has to mirror the original entry exactly.
 * Re-deriving the account from today's map would reverse a 6400 write-down
 * against 5400 and leave residue in both, which invariant I13 would eventually
 * catch as inventory-vs-GL drift.
 *
 * Existing rows are backfilled to '6400' because that is where they actually
 * posted, whatever their reason says.
 */
export class InventoryAdjustmentOffsetAccount1787220000000 implements MigrationInterface {
  name = 'InventoryAdjustmentOffsetAccount1787220000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_adjustments"
        ADD COLUMN IF NOT EXISTS "offset_account_number" character varying(20)
    `);

    await queryRunner.query(`
      UPDATE "inventory_adjustments"
         SET "offset_account_number" = '6400'
       WHERE "offset_account_number" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_adjustments" DROP COLUMN IF EXISTS "offset_account_number"
    `);
  }
}
