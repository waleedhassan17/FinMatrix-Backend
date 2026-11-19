import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Day Summary (reports/day-summary): what the business did on one day, and an
 * optional end-of-day digest to the owner.
 *
 * Schema (additive):
 *  - company_settings.day_summary_*: the owner's digest choice — on/off, the
 *    local hour it goes out, whether it is also emailed — and the last local
 *    day it was sent, which the hourly job claims atomically so two API
 *    instances never send the same day twice.
 *  - Indexes on each document's own date column. The summary filters by
 *    document date (invoice_date, payment_date, …); until now only
 *    (company_id, created_at) was indexed, so a one-day read scanned every
 *    document the company ever raised.
 *  - approval_requests (company_id, result_id): the summary credits a
 *    document an owner approved to the staff member who prepared it, found
 *    through the request that produced it.
 *
 * Re-runnable: every statement is guarded.
 */
export class DaySummary1791200000000 implements MigrationInterface {
  name = 'DaySummary1791200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "company_settings"
        ADD COLUMN IF NOT EXISTS "day_summary_enabled" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "day_summary_hour" smallint NOT NULL DEFAULT 21,
        ADD COLUMN IF NOT EXISTS "day_summary_email" boolean NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS "day_summary_last_sent" date NULL
    `);
    for (const [name, table, cols] of INDEXES) {
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "${name}" ON "${table}" (${cols})`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const [name] of INDEXES) {
      await queryRunner.query(`DROP INDEX IF EXISTS "${name}"`);
    }
    await queryRunner.query(`
      ALTER TABLE "company_settings"
        DROP COLUMN IF EXISTS "day_summary_enabled",
        DROP COLUMN IF EXISTS "day_summary_hour",
        DROP COLUMN IF EXISTS "day_summary_email",
        DROP COLUMN IF EXISTS "day_summary_last_sent"
    `);
  }
}

/** [index name, table, column list] — the entities declare the same names. */
const INDEXES: ReadonlyArray<readonly [string, string, string]> = [
  [
    'IDX_invoices_company_invoice_date',
    'invoices',
    '"company_id", "invoice_date"',
  ],
  [
    'IDX_payments_company_payment_date',
    'payments',
    '"company_id", "payment_date"',
  ],
  [
    'IDX_sales_orders_company_order_date',
    'sales_orders',
    '"company_id", "order_date"',
  ],
  ['IDX_bills_company_bill_date', 'bills', '"company_id", "bill_date"'],
  [
    'IDX_approval_requests_company_result',
    'approval_requests',
    '"company_id", "result_id"',
  ],
];
