import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Stage 1 — Authentication + Company Onboarding.
 *
 *   - users: email verification flags
 *   - companies: QuickBooks-style onboarding fields + submitted_at
 *   - email_verifications: single-use verification tokens
 *   - password_reset_otps: OTP-based password reset flow
 */
export class Stage1Auth1780000000000 implements MigrationInterface {
  name = 'Stage1Auth1780000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── users ────────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD COLUMN IF NOT EXISTS "is_email_verified" boolean NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS "email_verified_at" TIMESTAMP WITH TIME ZONE
    `);
    // Existing accounts predate email verification — treat them as verified so
    // the new sign-in gate never locks out current users.
    await queryRunner.query(`
      UPDATE "users"
      SET "is_email_verified" = true, "email_verified_at" = now()
      WHERE "email_verified_at" IS NULL
    `);

    // ── companies ────────────────────────────────────────────────────────
    await queryRunner.query(`
      ALTER TABLE "companies"
      ADD COLUMN IF NOT EXISTS "legal_structure" character varying(32),
      ADD COLUMN IF NOT EXISTS "website" character varying(255),
      ADD COLUMN IF NOT EXISTS "fiscal_year_start_month" smallint,
      ADD COLUMN IF NOT EXISTS "accounting_method" character varying(16),
      ADD COLUMN IF NOT EXISTS "home_currency" character varying(8),
      ADD COLUMN IF NOT EXISTS "submitted_at" TIMESTAMP WITH TIME ZONE
    `);

    // ── email_verifications ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "email_verifications" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "token_hash" character varying(255) NOT NULL,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "used_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_email_verifications" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_email_verifications_token_hash" UNIQUE ("token_hash")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_email_verifications_user_id"
      ON "email_verifications" ("user_id")
    `);

    // ── password_reset_otps ──────────────────────────────────────────────
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "password_reset_otps" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "user_id" uuid NOT NULL,
        "otp_hash" character varying(255) NOT NULL,
        "reset_token_hash" character varying(255),
        "attempts" integer NOT NULL DEFAULT 0,
        "expires_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "verified_at" TIMESTAMP WITH TIME ZONE,
        "used_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_password_reset_otps" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_password_reset_otps_user_id"
      ON "password_reset_otps" ("user_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "password_reset_otps"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "email_verifications"`);
    await queryRunner.query(`
      ALTER TABLE "companies"
      DROP COLUMN IF EXISTS "legal_structure",
      DROP COLUMN IF EXISTS "website",
      DROP COLUMN IF EXISTS "fiscal_year_start_month",
      DROP COLUMN IF EXISTS "accounting_method",
      DROP COLUMN IF EXISTS "home_currency",
      DROP COLUMN IF EXISTS "submitted_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      DROP COLUMN IF EXISTS "is_email_verified",
      DROP COLUMN IF EXISTS "email_verified_at"
    `);
  }
}
