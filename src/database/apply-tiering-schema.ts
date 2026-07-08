/**
 * Idempotent one-off: ensures the FinMatrix.md three-tier schema exists
 * (companies.company_type / inventory_enabled / all_features_unlocked +
 * widened subscription_plan) and records the CompanyTiering migration as
 * applied. Safe to run multiple times.
 *
 *   heroku run node dist/database/apply-tiering-schema.js -a finmatrix-api-prod
 *
 * Used because this database's migration history predates the migrations
 * table (older migrations try to CREATE existing tables), so `migration:run`
 * aborts on prod. Additive only — NEVER drops data.
 *
 * ⚠️ Per FinMatrix.md SAFETY §2, take a backup FIRST:
 *   heroku pg:backups:capture -a finmatrix-api-prod
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
      ADD COLUMN IF NOT EXISTS "company_type" character varying(20),
      ADD COLUMN IF NOT EXISTS "inventory_enabled" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "all_features_unlocked" boolean NOT NULL DEFAULT false
  `);
  await client.query(
    `ALTER TABLE "companies" ALTER COLUMN "subscription_plan" TYPE character varying(32)`,
  );
  await client.query(
    `ALTER TABLE "platform_payment_submissions" ALTER COLUMN "plan" TYPE character varying(32)`,
  );
  await client.query(
    `ALTER TABLE "platform_revenue" ALTER COLUMN "plan" TYPE character varying(32)`,
  );
  // Pre-tiering companies keep everything they have today (audit §7.2).
  const res = await client.query(
    `UPDATE "companies" SET "company_type" = 'warehouse' WHERE "company_type" IS NULL`,
  );
  console.log(`✔ tiering columns present; ${res.rowCount} legacy companies defaulted to 'warehouse'`);

  // Record the migration row so a future fixed migration:run skips it.
  await client.query(`
    INSERT INTO "migrations" ("timestamp", "name")
    SELECT 1783750000000, 'CompanyTiering1783750000000'
    WHERE NOT EXISTS (
      SELECT 1 FROM "migrations" WHERE "name" = 'CompanyTiering1783750000000'
    )
  `);

  const check = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'companies'
      AND column_name IN ('company_type', 'inventory_enabled', 'all_features_unlocked')
    ORDER BY column_name
  `);
  console.log('✔ verified columns:', check.rows.map((r: { column_name: string }) => r.column_name).join(', '));

  await client.end();
}

main().catch((e) => {
  console.error('apply-tiering-schema failed:', e);
  process.exit(1);
});
