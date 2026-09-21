import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Step 2 of 3: every NEW stock movement must record what it did to inventory
 * value.
 *
 * ── Why a constraint and not a convention ──────────────────────────────────
 *
 * Per-item value history is a RUNNING SUM, and a running sum is only as good as
 * its weakest link. Fifteen call sites write stock movements; if one of them —
 * or one added next year — omits the value, `SUM(value_change)` silently stops
 * equalling the movement of GL 1200 and the report returns a plausible wrong
 * number that nobody finds for six months. A code review cannot promise that
 * and a comment certainly cannot.
 *
 * NOT VALID exempts the rows already here (the backfill fills those) while
 * checking every INSERT and UPDATE from now on. That is the same pattern
 * LedgerIntegrityConstraints uses for chk_no_negative_stock, and for the same
 * reason: it turns "someone forgot" from a silent reporting defect into a loud
 * failure on the day the code is written.
 *
 * ── Why this is a SEPARATE migration from the write path ───────────────────
 *
 * It must not ship in the same deploy as the code that fills the column. If a
 * call site had been missed, landing them together would turn every stock
 * movement in the system into a 500 — invoicing, receiving and deliveries all
 * down at once, in an accounting app. Staged, a missed site writes a NULL for
 * one deploy's worth of data, the acceptance suite catches it, and this
 * constraint then holds the line.
 *
 * So: deploy the write path, let the acceptance suite run green against it,
 * and only then deploy this.
 *
 * Posts nothing, and changes no existing row.
 */
export class InventoryMovementValueRequired1789920000000
  implements MigrationInterface
{
  name = 'InventoryMovementValueRequired1789920000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Dropped first so a re-run replaces rather than fails.
    await queryRunner.query(`
      ALTER TABLE "inventory_movements"
        DROP CONSTRAINT IF EXISTS "chk_movement_value_known"
    `);
    await queryRunner.query(`
      ALTER TABLE "inventory_movements"
        ADD CONSTRAINT "chk_movement_value_known"
        CHECK ("value_change" IS NOT NULL) NOT VALID
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_movements"
        DROP CONSTRAINT IF EXISTS "chk_movement_value_known"
    `);
  }
}
