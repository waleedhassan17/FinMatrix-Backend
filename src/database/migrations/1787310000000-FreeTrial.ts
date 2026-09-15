import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Admin-approved 30-day free trial.
 *
 * Requesting a trial does NOT grant access: it files a kind='TRIAL' row in the
 * existing platform_payment_submissions queue, and a super-admin approves or
 * rejects it like a payment. An approved trial is an ordinary subscription on
 * the `warehouse_trial` plan key with an expiry 30 days after APPROVAL, so
 * CompanyGuard, effectiveCompanyStatus and the expiry cron need nothing new.
 * What IS new is history, and the one-trial-per-person guarantee:
 *
 *   companies    — is_trial / trial_requested_at / trial_started_at /
 *                  trial_converted_at, plus trial_reminder_milestone to dedupe
 *                  the 7/3/1-day trial-ending emails.
 *   trial_claims — normalized email + phone behind each request. The PARTIAL
 *                  unique indexes are the real guarantee: a claim that was
 *                  released (rejected without blocking) must not stand in the
 *                  way of a later request, so it is excluded from the index.
 *
 * Nothing else needs DDL, and that was checked rather than assumed:
 *   - platform_payment_submissions.kind is varchar(16) with no CHECK, so 'TRIAL'
 *     is a TypeScript-only change — no ALTER TYPE and none of the "new enum
 *     value unusable inside its own transaction" trouble.
 *   - amount_minor_units stays NOT NULL (a trial row carries 0); the screenshot
 *     columns are already nullable.
 *   - delivery_personnel_profiles.status is varchar(16) with no CHECK, so the
 *     system-set 'plan_locked' value fits as-is.
 *   - plan columns are varchar(32) since CompanyTiering; 'warehouse_trial' fits.
 *
 * Touches no ledger, journal or document table.
 */
export class FreeTrial1787310000000 implements MigrationInterface {
  name = 'FreeTrial1787310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "is_trial" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "trial_requested_at" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "trial_started_at" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "trial_converted_at" TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS "trial_reminder_milestone" smallint
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "trial_claims" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "email_normalized" text NOT NULL,
        "phone_normalized" text,
        "company_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "submission_id" uuid,
        "status" text NOT NULL DEFAULT 'pending',
        "decided_at" TIMESTAMPTZ,
        CONSTRAINT "pk_trial_claims" PRIMARY KEY ("id"),
        CONSTRAINT "fk_trial_claims_company" FOREIGN KEY ("company_id")
          REFERENCES "companies" ("id"),
        CONSTRAINT "fk_trial_claims_user" FOREIGN KEY ("user_id")
          REFERENCES "users" ("id"),
        CONSTRAINT "fk_trial_claims_submission" FOREIGN KEY ("submission_id")
          REFERENCES "platform_payment_submissions" ("id"),
        CONSTRAINT "CHK_trial_claims_status"
          CHECK ("status" IN ('pending', 'approved', 'released', 'blocked'))
      )
    `);

    // One live claim per email / per phone. `released` rows are left out so a
    // rejected-without-blocking request frees the address for a new attempt.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_trial_claims_email"
        ON "trial_claims" ("email_normalized")
        WHERE "status" <> 'released'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_trial_claims_phone"
        ON "trial_claims" ("phone_normalized")
        WHERE "status" <> 'released' AND "phone_normalized" IS NOT NULL
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_trial_claims_submission"
        ON "trial_claims" ("submission_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Data written under the new code has to be left in a shape the OLD code
    // reads correctly, before the columns that explain it disappear.

    // Old code has no 'plan_locked'. 'inactive' is the safe equivalent: the
    // rider keeps their data, does not count against the limit, and the owner
    // must deliberately reactivate them.
    await queryRunner.query(`
      UPDATE "delivery_personnel_profiles"
         SET "status" = 'inactive'
       WHERE "status" = 'plan_locked'
    `);

    // Old code does not know 'warehouse_trial': normalizePlan would turn it
    // into 'free', and a free plan NEVER EXPIRES — every running trial would
    // silently become permanent free access. Starter keeps the expiry date
    // working and its rider allowance covers the trial's one rider.
    await queryRunner.query(`
      UPDATE "companies"
         SET "subscription_plan" = 'warehouse_starter_6mo'
       WHERE "subscription_plan" = 'warehouse_trial'
    `);

    // A trial request still in review cannot be reviewed by old code. Put the
    // draft company back where it was before asking, then remove the requests.
    await queryRunner.query(`
      UPDATE "companies" c
         SET "payment_status" = 'none',
             "last_submission_id" = NULL
        FROM "platform_payment_submissions" s
       WHERE s."id" = c."last_submission_id"
         AND s."kind" = 'TRIAL'
         AND c."payment_status" = 'submitted'
    `);
    await queryRunner.query(`
      UPDATE "companies" c
         SET "last_submission_id" = NULL
        FROM "platform_payment_submissions" s
       WHERE s."id" = c."last_submission_id"
         AND s."kind" = 'TRIAL'
    `);

    await queryRunner.query(`DROP TABLE IF EXISTS "trial_claims"`);
    await queryRunner.query(
      `DELETE FROM "platform_payment_submissions" WHERE "kind" = 'TRIAL'`,
    );

    await queryRunner.query(`
      ALTER TABLE "companies"
        DROP COLUMN IF EXISTS "trial_reminder_milestone",
        DROP COLUMN IF EXISTS "trial_converted_at",
        DROP COLUMN IF EXISTS "trial_started_at",
        DROP COLUMN IF EXISTS "trial_requested_at",
        DROP COLUMN IF EXISTS "is_trial"
    `);
  }
}
