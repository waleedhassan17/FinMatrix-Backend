import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Reconciles the migration chain with the entities.
 *
 * Every FinMatrix database in existence was built with DB_SYNCHRONIZE=true, so
 * the entities and the running schemas have stayed in step while the MIGRATION
 * chain quietly fell behind: three tables and twenty-two columns were added to
 * entities over time and never written into a migration. A database built by
 * `migration:run` alone therefore could not boot the app — the first query
 * against companies died on `column Company.status does not exist` — which is
 * why the acceptance workflow, which builds its database that way, could never
 * get past seeding.
 *
 * Everything here is ADDITIVE and IDEMPOTENT: `IF NOT EXISTS` throughout, so
 * against a database that already has these (which is every real one) it is a
 * no-op, and against a migrations-only database it fills the gap. Nothing is
 * dropped or altered.
 *
 * Legacy tables that exist in the migration chain but no longer have entities
 * — bank_accounts, bank_transactions, credit_memo_applications, paystubs — are
 * deliberately LEFT ALONE. They are harmless to the running app and may hold
 * real rows; dropping them belongs in its own reviewed change, not in a
 * catch-up.
 */
export class SchemaCatchUp1787280000000 implements MigrationInterface {
  name = 'SchemaCatchUp1787280000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── Tables the chain never created ──────────────────────────────────
    // Constraints are declared inline rather than as separate ADD CONSTRAINT
    // statements: CREATE TABLE IF NOT EXISTS skips the whole statement on a
    // database that already has the table, so the names can never collide
    // with the ones synchronize generated there.
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "subscription_plans" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "name" character varying(100) NOT NULL,
        "description" text,
        "priceMonthly" numeric(10,2) NOT NULL DEFAULT '0',
        "priceYearly" numeric(10,2) NOT NULL DEFAULT '0',
        "maxUsers" integer NOT NULL DEFAULT 5,
        "maxInvoices" integer,
        "features" jsonb,
        "isActive" boolean NOT NULL DEFAULT true,
        "sortOrder" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_subscription_plans" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "company_subscriptions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "company_id" uuid NOT NULL,
        "plan_id" uuid NOT NULL,
        "status" character varying(20) NOT NULL DEFAULT 'active',
        "start_date" date NOT NULL,
        "end_date" date,
        "notes" text,
        "assigned_by" uuid NOT NULL,
        CONSTRAINT "PK_company_subscriptions" PRIMARY KEY ("id"),
        CONSTRAINT "FK_company_subscriptions_plan"
          FOREIGN KEY ("plan_id") REFERENCES "subscription_plans"("id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "delivery_location_logs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "delivery_id" uuid NOT NULL,
        "personnel_id" uuid NOT NULL,
        "lat" double precision NOT NULL,
        "lng" double precision NOT NULL,
        "heading" double precision,
        "speed" double precision,
        "accuracy" double precision,
        "status" character varying(20) NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_delivery_location_logs" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_delivery_location_logs_delivery"
         ON "delivery_location_logs" ("delivery_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_delivery_location_logs_personnel"
         ON "delivery_location_logs" ("personnel_id", "created_at")`,
    );

    // ── Columns added to existing tables ────────────────────────────────
    // companies: the approval workflow (super-admin reviews a registration).
    // `status` is the one that broke every migrations-built database.
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "status" character varying(20) DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS "reviewed_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "reviewed_by" uuid,
        ADD COLUMN IF NOT EXISTS "rejection_reason" text
    `);

    await queryRunner.query(`
      ALTER TABLE "agencies"
        ADD COLUMN IF NOT EXISTS "inventory" jsonb NOT NULL DEFAULT '[]'::jsonb,
        ADD COLUMN IF NOT EXISTS "isActive" boolean NOT NULL DEFAULT true
    `);

    await queryRunner.query(`
      ALTER TABLE "deliveries"
        ADD COLUMN IF NOT EXISTS "customer_name" character varying(200),
        ADD COLUMN IF NOT EXISTS "zone" character varying(100),
        ADD COLUMN IF NOT EXISTS "reference_no" character varying(32)
    `);

    await queryRunner.query(`
      ALTER TABLE "delivery_items"
        ADD COLUMN IF NOT EXISTS "item_name" character varying(200),
        ADD COLUMN IF NOT EXISTS "quantity" numeric(18,4) NOT NULL DEFAULT '0',
        ADD COLUMN IF NOT EXISTS "agency_id" uuid,
        ADD COLUMN IF NOT EXISTS "agency_name" character varying(200)
    `);

    // Riders' last known position, written by the tracking endpoint.
    await queryRunner.query(`
      ALTER TABLE "delivery_personnel_profiles"
        ADD COLUMN IF NOT EXISTS "current_lat" numeric(10,7),
        ADD COLUMN IF NOT EXISTS "current_lng" numeric(10,7),
        ADD COLUMN IF NOT EXISTS "heading" double precision,
        ADD COLUMN IF NOT EXISTS "speed" double precision,
        ADD COLUMN IF NOT EXISTS "accuracy" double precision,
        ADD COLUMN IF NOT EXISTS "location_updated_at" TIMESTAMP WITH TIME ZONE
    `);

    await queryRunner.query(`
      ALTER TABLE "shadow_inventory_snapshots"
        ADD COLUMN IF NOT EXISTS "item_name" character varying(200)
    `);
  }

  /**
   * Deliberately a no-op.
   *
   * This migration does not introduce these tables and columns — it records
   * ones that already exist everywhere the app runs. Mirroring `up` here would
   * mean a `migration:revert` drops live columns, taking their data with them,
   * on every database that had them long before this file existed. There is
   * nothing to undo: reverting to the state before this migration is the
   * broken state it exists to fix.
   */
  public async down(): Promise<void> {
    // Intentionally empty — see the note above.
  }
}
