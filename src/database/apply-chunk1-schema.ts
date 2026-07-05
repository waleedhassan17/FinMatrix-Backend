/**
 * Idempotent one-off: ensures the phase3 Chunk 1 schema exists
 * (customer record fields + operational audit events + durable file storage)
 * and records the migrations as applied. Safe to run multiple times.
 *
 *   heroku run node dist/database/apply-chunk1-schema.js -a finmatrix-api-prod
 *
 * Used because this database's migration history predates the migrations
 * table (older migrations try to CREATE existing tables), so `migration:run`
 * can abort. This applies only additive, IF-NOT-EXISTS changes. NEVER drops data.
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

  // 1783700000000-CustomerRecordFields
  await client.query(`
    ALTER TABLE "customers"
      ADD COLUMN IF NOT EXISTS "contact_person" varchar(200),
      ADD COLUMN IF NOT EXISTS "tax_id" varchar(64),
      ADD COLUMN IF NOT EXISTS "shipping_lat" double precision,
      ADD COLUMN IF NOT EXISTS "shipping_lng" double precision,
      ADD COLUMN IF NOT EXISTS "shipping_geocoded_at" timestamptz
  `);

  // 1783710000000-OperationalAuditEvents
  await client.query(`
    CREATE TABLE IF NOT EXISTS "operational_audit_events" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "company_id" uuid NOT NULL,
      "actor_user_id" uuid,
      "action" varchar(64) NOT NULL,
      "target_type" varchar(64) NOT NULL,
      "target_id" varchar(64),
      "details" jsonb,
      "created_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "idx_op_audit_company_created"
      ON "operational_audit_events" ("company_id", "created_at")
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "idx_op_audit_company_target"
      ON "operational_audit_events" ("company_id", "target_type", "target_id")
  `);

  // 1783720000000-StoredFiles
  await client.query(`
    CREATE TABLE IF NOT EXISTS "stored_files" (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "bucket" varchar(64) NOT NULL,
      "mime_type" varchar(128) NOT NULL,
      "original_name" varchar(255) NOT NULL,
      "size" integer NOT NULL,
      "data" bytea NOT NULL,
      "created_at" timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "idx_stored_files_bucket_created"
      ON "stored_files" ("bucket", "created_at")
  `);

  // 1783730000000-ApprovalJournalLink (chunk 2)
  await client.query(`
    ALTER TABLE "inventory_update_requests"
      ADD COLUMN IF NOT EXISTS "journal_entry_id" uuid
  `);

  // Record the migrations as applied so future migration:run attempts skip them.
  await client.query(`CREATE TABLE IF NOT EXISTS "migrations" (
    "id" SERIAL PRIMARY KEY, "timestamp" bigint NOT NULL, "name" varchar NOT NULL
  )`);
  const rows: Array<[number, string]> = [
    [1783700000000, 'CustomerRecordFields1783700000000'],
    [1783710000000, 'OperationalAuditEvents1783710000000'],
    [1783720000000, 'StoredFiles1783720000000'],
    [1783730000000, 'ApprovalJournalLink1783730000000'],
  ];
  for (const [ts, name] of rows) {
    await client.query(
      `INSERT INTO "migrations" ("timestamp", "name")
       SELECT $1::bigint, $2::varchar
       WHERE NOT EXISTS (SELECT 1 FROM "migrations" WHERE "name" = $2::varchar)`,
      [ts, name],
    );
  }

  const check = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM information_schema.columns
        WHERE table_name = 'customers' AND column_name IN
          ('contact_person','tax_id','shipping_lat','shipping_lng','shipping_geocoded_at')) AS customer_cols,
      (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'operational_audit_events') AS audit_table,
      (SELECT COUNT(*) FROM information_schema.tables WHERE table_name = 'stored_files') AS files_table
  `);
  console.log('chunk1 schema check:', check.rows[0]);
  await client.end();
  console.log('✔ phase3 Chunk 1 schema ensured (idempotent).');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
