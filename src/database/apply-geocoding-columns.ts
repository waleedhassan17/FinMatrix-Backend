/**
 * Idempotent one-off: ensures the delivery destination geocoding columns exist
 * and records the migration as applied. Safe to run multiple times.
 *
 *   heroku run node dist/database/apply-geocoding-columns.js -a finmatrix-api
 *
 * Used because this database's migration history predates the migrations table
 * (older migrations try to CREATE existing tables), so `migration:run` aborts.
 * This applies only the additive, IF-NOT-EXISTS column changes.
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
    ALTER TABLE "deliveries"
      ADD COLUMN IF NOT EXISTS "address"      character varying(300),
      ADD COLUMN IF NOT EXISTS "dest_lat"     double precision,
      ADD COLUMN IF NOT EXISTS "dest_lng"     double precision,
      ADD COLUMN IF NOT EXISTS "geocoded_at"  TIMESTAMP WITH TIME ZONE
  `);

  await client.query(`
    INSERT INTO migrations("timestamp", name)
    SELECT 1781200000000, 'DeliveryDestinationGeocoding1781200000000'
    WHERE NOT EXISTS (
      SELECT 1 FROM migrations WHERE name = 'DeliveryDestinationGeocoding1781200000000'
    )
  `);

  const res = await client.query(`
    SELECT column_name FROM information_schema.columns
    WHERE table_name = 'deliveries'
      AND column_name IN ('address', 'dest_lat', 'dest_lng', 'geocoded_at')
    ORDER BY column_name
  `);
  console.log(
    '[apply-geocoding-columns] columns present:',
    res.rows.map((r: { column_name: string }) => r.column_name).join(', ') || '(none)',
  );

  await client.end();
}

main()
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error('[apply-geocoding-columns] FAILED:', err.message);
    process.exit(1);
  });
