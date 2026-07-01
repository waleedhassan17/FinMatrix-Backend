import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase1.md — add the chosen subscription plan to the company account
 * (free | standard | pro). Only 'free' is selectable now; paid tiers are
 * display-only. Idempotent.
 */
export class CompanySubscriptionPlan1783400000000
  implements MigrationInterface
{
  name = 'CompanySubscriptionPlan1783400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "subscription_plan" character varying(16) NOT NULL DEFAULT 'free'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies" DROP COLUMN IF EXISTS "subscription_plan"
    `);
  }
}
