/**
 * Idempotent one-off: ensures the bill-photo / inventory-approval schema exists
 * (the BillPhotoCaptureAndApproval migration). This DB's migration history
 * predates the migrations table, so `migration:run` aborts on older
 * CREATE-TABLE statements and this migration may never have applied — which
 * makes approving an inventory request 500 (missing audit table / columns).
 *
 * All statements are IF NOT EXISTS / guarded, so it's safe to re-run.
 *
 *   heroku run node dist/database/ensure-approval-schema.js -a finmatrix-api
 */
/* eslint-disable @typescript-eslint/no-var-requires */
export {};
const { Client } = require('pg');

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await client.connect();

  const before = await client.query(
    `SELECT to_regclass('public.inventory_approval_audit_entries') AS audit`,
  );
  console.log('[ensure-approval-schema] audit table BEFORE:', before.rows[0].audit);

  await client.query(`
    ALTER TABLE "deliveries"
      ADD COLUMN IF NOT EXISTS "bill_photo_url"          text,
      ADD COLUMN IF NOT EXISTS "bill_photo_storage_key"  text,
      ADD COLUMN IF NOT EXISTS "bill_photo_captured_at"  TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS "bill_signed_by"          character varying(200)
  `);

  await client.query(`
    ALTER TABLE "inventory_update_requests"
      ADD COLUMN IF NOT EXISTS "delivery_reference"            character varying(64),
      ADD COLUMN IF NOT EXISTS "personnel_name"                character varying(200),
      ADD COLUMN IF NOT EXISTS "route_label"                   character varying(200),
      ADD COLUMN IF NOT EXISTS "shadow_status"                 character varying(16) NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS "reviewer_comment"              text,
      ADD COLUMN IF NOT EXISTS "proof_signed_by"               character varying(200),
      ADD COLUMN IF NOT EXISTS "proof_verification_method"     character varying(32) NOT NULL DEFAULT 'bill_photo',
      ADD COLUMN IF NOT EXISTS "proof_verified_by"             character varying(200),
      ADD COLUMN IF NOT EXISTS "proof_verified_at"             TIMESTAMP WITH TIME ZONE,
      ADD COLUMN IF NOT EXISTS "proof_bill_photo_url"          text,
      ADD COLUMN IF NOT EXISTS "proof_bill_photo_storage_key"  text,
      ADD COLUMN IF NOT EXISTS "proof_bill_photo_captured_at"  TIMESTAMP WITH TIME ZONE
  `);

  await client.query(`
    ALTER TABLE "inventory_update_request_lines"
      ADD COLUMN IF NOT EXISTS "item_name" character varying(200)
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS "inventory_approval_audit_entries" (
      "id"          uuid NOT NULL DEFAULT uuid_generate_v4(),
      "company_id"  uuid NOT NULL,
      "request_id"  uuid NOT NULL,
      "action"      character varying(16) NOT NULL,
      "reviewed_by" uuid NOT NULL,
      "details"     text,
      "created_at"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
      CONSTRAINT "PK_inv_approval_audit_entries" PRIMARY KEY ("id")
    )
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS "IDX_inv_audit_request_created"
      ON "inventory_approval_audit_entries" ("request_id", "created_at")
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS "IDX_inv_audit_company_created"
      ON "inventory_approval_audit_entries" ("company_id", "created_at")
  `);

  // Remove orphaned audit rows (referencing deleted requests) so the FK can be
  // added, then add it only if missing (ADD CONSTRAINT is not idempotent).
  await client.query(`
    DELETE FROM "inventory_approval_audit_entries" a
     WHERE NOT EXISTS (
       SELECT 1 FROM "inventory_update_requests" r WHERE r.id = a.request_id
     )
  `);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'FK_inv_audit_request') THEN
        ALTER TABLE "inventory_approval_audit_entries"
          ADD CONSTRAINT "FK_inv_audit_request"
          FOREIGN KEY ("request_id") REFERENCES "inventory_update_requests" ("id")
          ON DELETE CASCADE ON UPDATE NO ACTION;
      END IF;
    END $$;
  `);

  await client.query(`
    CREATE INDEX IF NOT EXISTS "IDX_inv_req_delivery"
      ON "inventory_update_requests" ("delivery_id")
  `);

  await client.query(`
    INSERT INTO migrations("timestamp", name)
    SELECT 1777612800000, 'BillPhotoCaptureAndApproval1777612800000'
    WHERE NOT EXISTS (
      SELECT 1 FROM migrations WHERE name = 'BillPhotoCaptureAndApproval1777612800000'
    )
  `);

  const after = await client.query(
    `SELECT to_regclass('public.inventory_approval_audit_entries') AS audit`,
  );
  console.log('[ensure-approval-schema] audit table AFTER:', after.rows[0].audit);

  await client.end();
}

main()
  .then(() => process.exit(0))
  .catch((err: Error) => {
    console.error('[ensure-approval-schema] FAILED:', err.message);
    process.exit(1);
  });
