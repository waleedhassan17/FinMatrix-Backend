import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-company report defaults, so a chosen A/R and A/P aging scheme sticks.
 *
 * The aging report was fixed at 30/60/90, which is useless to a warehouse
 * trading on 3-day or 7-day terms — everything open collapses into "Current".
 * The buckets are now configurable per request, and this column is where a
 * company's preferred scheme lives between visits:
 *
 *   { "aging": { "preset": "weekly" } }
 *   { "aging": { "preset": "custom", "buckets": "3,6,9,12" } }
 *
 * jsonb rather than a column per preference: these are presentation choices
 * with no referential meaning. Nothing joins on them, no invariant reads them,
 * and the next report to want a default should not need a migration.
 *
 * Nullable with no default. A NULL means "this company has never chosen", which
 * ReportsService reads as the classic 30/60/90 — the same report it showed
 * before this shipped, so nothing changes for anyone until they ask it to.
 *
 * ReportsService tolerates this column not existing (it catches 42703 and logs)
 * so that a deploy which lands the code before the migration degrades to the
 * default rather than taking both aging reports down.
 */
export class CompanyReportPreferences1789900000000 implements MigrationInterface {
  name = 'CompanyReportPreferences1789900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // IF NOT EXISTS so a re-run, or a database built by synchronize in dev, is
    // a no-op rather than a failure.
    await queryRunner.query(`
      ALTER TABLE "company_settings"
        ADD COLUMN IF NOT EXISTS "report_preferences" jsonb NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Safe to reverse: the column holds only presentation preferences, and
    // dropping it returns every company to the 30/60/90 default. No financial
    // figure is derived from it.
    await queryRunner.query(`
      ALTER TABLE "company_settings" DROP COLUMN IF EXISTS "report_preferences"
    `);
  }
}
