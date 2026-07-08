import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FinMatrix.md Phase 1 — three-tier model. ADDITIVE ONLY:
 *  - companies.company_type        (small_business | large_org | warehouse)
 *  - companies.inventory_enabled   (large-org per-company inventory toggle)
 *  - companies.all_features_unlocked (kill switch — SAFETY §4)
 *  - widens companies.subscription_plan varchar(16→32) for the six tier keys
 *
 * Existing companies default to company_type = 'warehouse': the audit showed
 * pre-tiering companies already use the full feature set (incl. deliveries),
 * so anything lower would take access away. No existing column is altered
 * beyond the widening, none dropped.
 */
export class CompanyTiering1783750000000 implements MigrationInterface {
  name = 'CompanyTiering1783750000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "company_type" varchar(20)`,
    );
    await queryRunner.query(
      `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "inventory_enabled" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "companies" ADD COLUMN IF NOT EXISTS "all_features_unlocked" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "companies" ALTER COLUMN "subscription_plan" TYPE varchar(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_payment_submissions" ALTER COLUMN "plan" TYPE varchar(32)`,
    );
    await queryRunner.query(
      `ALTER TABLE "platform_revenue" ALTER COLUMN "plan" TYPE varchar(32)`,
    );
    // Pre-tiering companies keep everything they have today.
    await queryRunner.query(
      `UPDATE "companies" SET "company_type" = 'warehouse' WHERE "company_type" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN IF EXISTS "all_features_unlocked"`);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN IF EXISTS "inventory_enabled"`);
    await queryRunner.query(`ALTER TABLE "companies" DROP COLUMN IF EXISTS "company_type"`);
    // varchar(32) → varchar(16) is safe to leave widened; narrowing could
    // truncate data, so the down-script intentionally keeps the wider column.
  }
}
