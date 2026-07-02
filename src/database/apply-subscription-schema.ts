/**
 * Idempotent one-off: ensures the phase2.md subscription-lifecycle schema exists
 * (company columns + platform_payment_submissions + platform_revenue) and records
 * the migration as applied. Safe to run multiple times.
 *
 *   heroku run node dist/database/apply-subscription-schema.js -a finmatrix-api-prod
 *
 * Used because this database's migration history predates the migrations table
 * (older migrations try to CREATE existing tables), so `migration:run` aborts.
 * This applies only the additive, IF-NOT-EXISTS changes. NEVER drops data.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
export {};
const { Client } = require('pg');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');

  const client = new Client({
    connectionString: url,
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  await client.query(`
    ALTER TABLE "companies"
      ADD COLUMN IF NOT EXISTS "subscription_status" character varying(16) NOT NULL DEFAULT 'active',
      ADD COLUMN IF NOT EXISTS "subscription_start_date" TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS "subscription_expiry_date" TIMESTAMPTZ,
      ADD COLUMN IF NOT EXISTS "payment_status" character varying(16) NOT NULL DEFAULT 'none',
      ADD COLUMN IF NOT EXISTS "last_submission_id" uuid,
      ADD COLUMN IF NOT EXISTS "subscription_reminder_on" date
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS "platform_payment_submissions" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "company_id" uuid NOT NULL,
      "plan" character varying(16) NOT NULL,
      "kind" character varying(16) NOT NULL,
      "status" character varying(16) NOT NULL DEFAULT 'submitted',
      "amount_minor_units" integer NOT NULL,
      "currency" character varying(8) NOT NULL DEFAULT 'PKR',
      "screenshot_key" text,
      "screenshot_mime" character varying(64),
      "submitted_by" uuid,
      "reviewed_by" uuid,
      "reviewed_at" TIMESTAMPTZ,
      "rejection_reason" text,
      CONSTRAINT "pk_platform_payment_submissions" PRIMARY KEY ("id")
    )
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS "idx_pps_company_created" ON "platform_payment_submissions" ("company_id", "created_at")`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS "idx_pps_status" ON "platform_payment_submissions" ("status")`,
  );

  await client.query(`
    CREATE TABLE IF NOT EXISTS "platform_revenue" (
      "id" uuid NOT NULL DEFAULT gen_random_uuid(),
      "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      "submission_id" uuid NOT NULL,
      "company_id" uuid NOT NULL,
      "plan" character varying(16) NOT NULL,
      "amount_minor_units" integer NOT NULL,
      "currency" character varying(8) NOT NULL DEFAULT 'PKR',
      "recorded_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT "pk_platform_revenue" PRIMARY KEY ("id"),
      CONSTRAINT "uq_platform_revenue_submission" UNIQUE ("submission_id")
    )
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS "idx_platform_revenue_company" ON "platform_revenue" ("company_id")`,
  );

  await client.query(`
    INSERT INTO migrations("timestamp", name)
    SELECT 1783500000000, 'SubscriptionLifecycle1783500000000'
    WHERE NOT EXISTS (
      SELECT 1 FROM migrations WHERE name = 'SubscriptionLifecycle1783500000000'
    )
  `);

  const res = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'companies'
      AND column_name IN ('subscription_status','subscription_start_date','subscription_expiry_date','payment_status','last_submission_id','subscription_reminder_on')
    ORDER BY column_name
  `);
  console.log(
    '[apply-subscription-schema] company columns present:',
    res.rows.map((r: { column_name: string }) => r.column_name).join(', ') || '(none)',
  );

  await client.end();
}

main()
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error('[apply-subscription-schema] FAILED:', err.message);
    process.exit(1);
  });
