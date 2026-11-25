import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Launch: the two sign-up paths, instant trials, platform audit, suspension.
 *
 *   companies
 *     requested_plan, approval_note     — path B "Request account approval"
 *     migration_prompt_dismissed_at     — the dashboard's migration card
 *     is_demo                           — demo/test accounts (bulk-deletable)
 *     suspended_at/_by, suspension_reason, status_before_suspension
 *                                       — super-admin suspension
 *   platform_payment_submissions
 *     auto_approved, review_source      — the system's instant trial approval
 *                                         (reviewed_by is a uuid; the system
 *                                         is not a user)
 *     hold_reason                       — why a trial was held for review
 *     note                              — the owner's note on an activation
 *   users
 *     suspended_at/_by, suspension_reason — super-admin suspension
 *     token_version                     — revokes every access token at once
 *   trial_attempts                      — per-IP attempt counter (risk signal)
 *   platform_audit_events               — super-admin actions; survives a
 *                                         company's deletion (no FK)
 *
 * Every column is nullable or defaulted, so the old release (still serving
 * while this runs, see the deploy notes) keeps writing rows that read as
 * "not suspended", "not demo", "decided by an admin". Touches no ledger,
 * journal or document table.
 */
export class SignupPathsAndSubmissionReview1791450000000 implements MigrationInterface {
  name = 'SignupPathsAndSubmissionReview1791450000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "requested_plan" varchar(32),
        ADD COLUMN IF NOT EXISTS "approval_note" text,
        ADD COLUMN IF NOT EXISTS "migration_prompt_dismissed_at" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "is_demo" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "suspended_at" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "suspended_by" uuid,
        ADD COLUMN IF NOT EXISTS "suspension_reason" text,
        ADD COLUMN IF NOT EXISTS "status_before_suspension" varchar(20)
    `);

    await queryRunner.query(`
      ALTER TABLE "users"
        ADD COLUMN IF NOT EXISTS "suspended_at" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "suspended_by" uuid,
        ADD COLUMN IF NOT EXISTS "suspension_reason" text,
        ADD COLUMN IF NOT EXISTS "token_version" integer NOT NULL DEFAULT 0
    `);

    await queryRunner.query(`
      ALTER TABLE "platform_payment_submissions"
        ADD COLUMN IF NOT EXISTS "auto_approved" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "review_source" varchar(16),
        ADD COLUMN IF NOT EXISTS "hold_reason" text,
        ADD COLUMN IF NOT EXISTS "note" text
    `);
    // Every decision made before this release was a person's.
    await queryRunner.query(`
      UPDATE "platform_payment_submissions"
         SET "review_source" = 'admin'
       WHERE "status" <> 'submitted' AND "review_source" IS NULL
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "trial_attempts" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "ip_hash" varchar(64),
        "user_id" uuid,
        "company_id" uuid,
        "outcome" varchar(64) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "pk_trial_attempts" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_trial_attempts_ip"
        ON "trial_attempts" ("ip_hash", "created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "platform_audit_events" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "actor_user_id" uuid,
        "actor_label" varchar(255),
        "action" varchar(64) NOT NULL,
        "target_type" varchar(64) NOT NULL,
        "target_id" varchar(64),
        "company_id" uuid,
        "company_name" varchar(200),
        "reason" text,
        "details" jsonb,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "pk_platform_audit_events" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_platform_audit_company"
        ON "platform_audit_events" ("company_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_platform_audit_action"
        ON "platform_audit_events" ("action", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_platform_audit_target"
        ON "platform_audit_events" ("target_type", "target_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A suspended company must not come back as active under old code: old
    // code reads status 'suspended' as inactive already, so leaving the status
    // as-is is the safe direction. An ACTIVATION request old code cannot
    // review is closed rather than left in the queue.
    await queryRunner.query(`
      UPDATE "companies" c
         SET "payment_status" = 'none'
        FROM "platform_payment_submissions" s
       WHERE s."id" = c."last_submission_id"
         AND s."kind" = 'ACTIVATION'
         AND c."payment_status" = 'submitted'
    `);
    await queryRunner.query(`
      UPDATE "platform_payment_submissions"
         SET "status" = 'rejected',
             "rejection_reason" = 'Withdrawn: this release was rolled back.'
       WHERE "kind" = 'ACTIVATION' AND "status" = 'submitted'
    `);
    await queryRunner.query(`DROP TABLE IF EXISTS "platform_audit_events"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "trial_attempts"`);
    await queryRunner.query(`
      ALTER TABLE "platform_payment_submissions"
        DROP COLUMN IF EXISTS "note",
        DROP COLUMN IF EXISTS "hold_reason",
        DROP COLUMN IF EXISTS "review_source",
        DROP COLUMN IF EXISTS "auto_approved"
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
        DROP COLUMN IF EXISTS "token_version",
        DROP COLUMN IF EXISTS "suspension_reason",
        DROP COLUMN IF EXISTS "suspended_by",
        DROP COLUMN IF EXISTS "suspended_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "companies"
        DROP COLUMN IF EXISTS "status_before_suspension",
        DROP COLUMN IF EXISTS "suspension_reason",
        DROP COLUMN IF EXISTS "suspended_by",
        DROP COLUMN IF EXISTS "suspended_at",
        DROP COLUMN IF EXISTS "is_demo",
        DROP COLUMN IF EXISTS "migration_prompt_dismissed_at",
        DROP COLUMN IF EXISTS "approval_note",
        DROP COLUMN IF EXISTS "requested_plan"
    `);
  }
}
