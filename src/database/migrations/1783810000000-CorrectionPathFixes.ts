import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G3 — the correction paths.
 *
 * Two defects found by exercising modules that had never processed a
 * transaction in production:
 *
 * 1. Vendor credits carried no tax at all. The journal entry was
 *    Dr AP / Cr expense, so returning goods to a vendor never reversed the
 *    recoverable input tax claimed on the original bill — leaving asset 1300
 *    overstated and the tax liability report wrong. Credit memos already do
 *    this correctly on the AR side; vendor credits now mirror them.
 *
 * 2. Credit-memo restock valued the return at the item's CURRENT
 *    weighted-average cost, read again at void time. If the average drifted
 *    between issue and void — a purchase at a new price is enough — the
 *    reversal did not equal the original entry and left residue in Inventory
 *    and COGS. Freezing the cost used at issue makes the void exact, the same
 *    way delivery lines already freeze unit_cost at dispatch.
 *
 * Additive and idempotent. Existing rows get 0 for the new tax columns, which
 * is exactly what they were worth before; restock_unit_cost stays NULL for
 * historical lines and the service falls back to the item cost for those.
 */
export class CorrectionPathFixes1783810000000 implements MigrationInterface {
  name = 'CorrectionPathFixes1783810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "vendor_credits"
        ADD COLUMN IF NOT EXISTS "subtotal"   numeric(18,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "tax_amount" numeric(18,4) NOT NULL DEFAULT 0
    `);

    // Backfill: before this change `total` was the net amount with no tax, so
    // subtotal = total keeps every historical vendor credit self-consistent.
    await queryRunner.query(`
      UPDATE "vendor_credits" SET "subtotal" = "total"
       WHERE "subtotal" = 0 AND "total" <> 0
    `);

    await queryRunner.query(`
      ALTER TABLE "vendor_credit_lines"
        ADD COLUMN IF NOT EXISTS "tax_rate" numeric(8,4) NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      ALTER TABLE "credit_memo_lines"
        ADD COLUMN IF NOT EXISTS "restock_unit_cost" numeric(18,4)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "credit_memo_lines" DROP COLUMN IF EXISTS "restock_unit_cost"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vendor_credit_lines" DROP COLUMN IF EXISTS "tax_rate"`,
    );
    await queryRunner.query(`
      ALTER TABLE "vendor_credits"
        DROP COLUMN IF EXISTS "tax_amount",
        DROP COLUMN IF EXISTS "subtotal"
    `);
  }
}
