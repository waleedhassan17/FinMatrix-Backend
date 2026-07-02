import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * phase2.md — subscription lifecycle.
 * Adds the subscription/billing fields to `companies` (account status stays in
 * the existing `status` column) and creates the platform payment-submission +
 * revenue tables. Idempotent (safe to re-run). Expiry NEVER deletes company
 * data — these are additive columns/tables only.
 */
export class SubscriptionLifecycle1783500000000 implements MigrationInterface {
  name = 'SubscriptionLifecycle1783500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── companies: subscription fields ──────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "subscription_status" character varying(16) NOT NULL DEFAULT 'active',
        ADD COLUMN IF NOT EXISTS "subscription_start_date" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "subscription_expiry_date" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "payment_status" character varying(16) NOT NULL DEFAULT 'none',
        ADD COLUMN IF NOT EXISTS "last_submission_id" uuid,
        ADD COLUMN IF NOT EXISTS "subscription_reminder_on" date
    `);

    // ── platform_payment_submissions ────────────────────────────────────────
    await queryRunner.query(`
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
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_pps_company_created" ON "platform_payment_submissions" ("company_id", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_pps_status" ON "platform_payment_submissions" ("status")`,
    );

    // ── platform_revenue (one row per approved submission — idempotent) ──────
    await queryRunner.query(`
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
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "idx_platform_revenue_company" ON "platform_revenue" ("company_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "platform_revenue"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "platform_payment_submissions"`);
    await queryRunner.query(`
      ALTER TABLE "companies"
        DROP COLUMN IF EXISTS "subscription_status",
        DROP COLUMN IF EXISTS "subscription_start_date",
        DROP COLUMN IF EXISTS "subscription_expiry_date",
        DROP COLUMN IF EXISTS "payment_status",
        DROP COLUMN IF EXISTS "last_submission_id",
        DROP COLUMN IF EXISTS "subscription_reminder_on"
    `);
  }
}
