import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One source of truth for the fiscal year.
 *
 * Two fields described it and nothing kept them in step:
 * `companies.fiscal_year_start_month` (1–12, written by company setup) and
 * `company_settings.fiscal_year_start` ('MM-DD', written by PATCH /settings).
 * From now on the company field is canonical — the reports split earnings at
 * it — and the settings value is derived from it and written through it.
 *
 * This carries across any year a company set ONLY through settings, so
 * nobody's fiscal year moves when the reports start reading the company
 * field. It fills NULLs and nothing else: a company field that is already set
 * is never overwritten, a January ('01-…') setting is the same as NULL and is
 * left alone, and an unparseable value is ignored. No column is dropped.
 */
export class FiscalYearStartCanonical1790300000000 implements MigrationInterface {
  name = 'FiscalYearStartCanonical1790300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "companies" c
         SET "fiscal_year_start_month" = substring(btrim(s."fiscal_year_start") from '^(\\d{1,2})')::smallint
        FROM "company_settings" s
       WHERE s."company_id" = c."id"
         AND c."fiscal_year_start_month" IS NULL
         AND btrim(s."fiscal_year_start") ~ '^(0?[2-9]|1[0-2])(-|$)'
    `);
  }

  public async down(): Promise<void> {
    // Nothing to undo: the copied month is the value the company already had
    // in settings, and clearing it would move that company's fiscal year.
  }
}
