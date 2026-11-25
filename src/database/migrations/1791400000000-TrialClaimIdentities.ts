import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One free trial per ACCOUNT, strictly.
 *
 * The trial is now granted instantly, with no person reviewing it, so the
 * one-trial rule widens from "one per email, one per phone" to every identity
 * of an account. Any one match refuses a new trial:
 *
 *   user_id            — the owner who already trialed one company cannot
 *                        trial a second company they create;
 *   company_id         — a company trials once;
 *   email_normalized   — now the trialEmailKey (Gmail dots and +tags folded);
 *   phone_normalized   — E.164, as before;
 *   tax_id_normalized  — NTN digits, when one was given (new).
 *
 * Each gets a PARTIAL unique index over the holding statuses
 * (pending/approved/blocked). `released` frees the identities; the new
 * `granted` status (a super-admin override) is history only and never holds.
 *
 * Deletion: company_id, user_id and submission_id become nullable with
 * ON DELETE SET NULL. Before this, the NO ACTION foreign keys made it
 * impossible to delete any company or user that had ever asked for a trial;
 * now deleting one keeps the email/phone/NTN keys (so a re-registered account
 * cannot farm trials) unless the admin releases them.
 *
 * Existing rows are brought onto the new rules defensively: an email key that
 * would collide with another live claim, or a second live claim for the same
 * user/company, is left as it was (the user/company reference nulled) and
 * counted in the log, so the unique indexes can always be created.
 *
 * Deploy window: the old release keeps inserting claims with every column set;
 * nothing here makes those inserts fail. Touches no ledger or document table.
 */
export class TrialClaimIdentities1791400000000 implements MigrationInterface {
  name = 'TrialClaimIdentities1791400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "trial_claims"
        ALTER COLUMN "email_normalized" DROP NOT NULL,
        ALTER COLUMN "company_id" DROP NOT NULL,
        ALTER COLUMN "user_id" DROP NOT NULL,
        ADD COLUMN IF NOT EXISTS "tax_id_normalized" text,
        ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'request',
        ADD COLUMN IF NOT EXISTS "release_reason" text
    `);

    // Foreign keys: SET NULL instead of NO ACTION.
    for (const [name, column, table] of [
      ['fk_trial_claims_company', 'company_id', 'companies'],
      ['fk_trial_claims_user', 'user_id', 'users'],
      [
        'fk_trial_claims_submission',
        'submission_id',
        'platform_payment_submissions',
      ],
    ] as const) {
      await queryRunner.query(
        `ALTER TABLE "trial_claims" DROP CONSTRAINT IF EXISTS "${name}"`,
      );
      await queryRunner.query(`
        ALTER TABLE "trial_claims"
          ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}")
          REFERENCES "${table}" ("id") ON DELETE SET NULL
      `);
    }

    await queryRunner.query(
      `ALTER TABLE "trial_claims" DROP CONSTRAINT IF EXISTS "CHK_trial_claims_status"`,
    );
    await queryRunner.query(`
      ALTER TABLE "trial_claims" ADD CONSTRAINT "CHK_trial_claims_status"
        CHECK ("status" IN ('pending', 'approved', 'released', 'blocked', 'granted'))
    `);

    // The old email/phone indexes go first so existing keys can be rewritten
    // without tripping them mid-way.
    await queryRunner.query(`DROP INDEX IF EXISTS "ux_trial_claims_email"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ux_trial_claims_phone"`);

    const holding = (s: string) =>
      s === 'pending' || s === 'approved' || s === 'blocked';

    const rows: Array<{
      id: string;
      email_normalized: string | null;
      user_id: string | null;
      company_id: string | null;
      status: string;
    }> = await queryRunner.query(
      `SELECT "id", "email_normalized", "user_id", "company_id", "status"
         FROM "trial_claims" ORDER BY "created_at", "id"`,
    );

    const liveEmails = new Set<string>();
    const liveUsers = new Set<string>();
    const liveCompanies = new Set<string>();
    let rekeyed = 0;
    let emailKept = 0;
    let userNulled = 0;
    let companyNulled = 0;

    for (const row of rows) {
      const live = holding(row.status);
      const key = trialEmailKey(row.email_normalized);
      let email = row.email_normalized;
      if (key && key !== email) {
        if (live && liveEmails.has(key)) {
          emailKept += 1; // would collide with an earlier live claim
        } else {
          email = key;
          rekeyed += 1;
        }
      }
      let userId = row.user_id;
      let companyId = row.company_id;
      if (live) {
        if (email) liveEmails.add(email);
        if (userId) {
          if (liveUsers.has(userId)) {
            userId = null;
            userNulled += 1;
          } else liveUsers.add(userId);
        }
        if (companyId) {
          if (liveCompanies.has(companyId)) {
            companyId = null;
            companyNulled += 1;
          } else liveCompanies.add(companyId);
        }
      }
      if (
        email !== row.email_normalized ||
        userId !== row.user_id ||
        companyId !== row.company_id
      ) {
        await queryRunner.query(
          `UPDATE "trial_claims"
              SET "email_normalized" = $2, "user_id" = $3, "company_id" = $4
            WHERE "id" = $1`,
          [row.id, email, userId, companyId],
        );
      }
    }

    const HOLDING = `"status" IN ('pending', 'approved', 'blocked')`;
    for (const [name, column] of [
      ['ux_trial_claims_email', 'email_normalized'],
      ['ux_trial_claims_phone', 'phone_normalized'],
      ['ux_trial_claims_user', 'user_id'],
      ['ux_trial_claims_company', 'company_id'],
      ['ux_trial_claims_tax_id', 'tax_id_normalized'],
    ] as const) {
      await queryRunner.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS "${name}"
          ON "trial_claims" ("${column}")
          WHERE ${HOLDING} AND "${column}" IS NOT NULL
      `);
    }

    console.log(
      `[TrialClaimIdentities] ${rows.length} claim(s): ${rekeyed} email key(s) rewritten, ` +
        `${emailKept} kept (collision), ${userNulled} duplicate user and ` +
        `${companyNulled} duplicate company reference(s) nulled.`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Back to the email/phone-only shape the old code reads. Rows the old
    // schema cannot hold (no email, no company or user) are removed; a granted
    // override becomes an approved claim, which is what it means to old code.
    await queryRunner.query(`DROP INDEX IF EXISTS "ux_trial_claims_tax_id"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ux_trial_claims_company"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ux_trial_claims_user"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ux_trial_claims_phone"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "ux_trial_claims_email"`);
    await queryRunner.query(`
      DELETE FROM "trial_claims"
       WHERE "email_normalized" IS NULL OR "company_id" IS NULL OR "user_id" IS NULL
    `);
    await queryRunner.query(
      `UPDATE "trial_claims" SET "status" = 'approved' WHERE "status" = 'granted'`,
    );
    await queryRunner.query(
      `ALTER TABLE "trial_claims" DROP CONSTRAINT IF EXISTS "CHK_trial_claims_status"`,
    );
    await queryRunner.query(`
      ALTER TABLE "trial_claims" ADD CONSTRAINT "CHK_trial_claims_status"
        CHECK ("status" IN ('pending', 'approved', 'released', 'blocked'))
    `);
    for (const [name, column, table] of [
      ['fk_trial_claims_company', 'company_id', 'companies'],
      ['fk_trial_claims_user', 'user_id', 'users'],
      [
        'fk_trial_claims_submission',
        'submission_id',
        'platform_payment_submissions',
      ],
    ] as const) {
      await queryRunner.query(
        `ALTER TABLE "trial_claims" DROP CONSTRAINT IF EXISTS "${name}"`,
      );
      await queryRunner.query(`
        ALTER TABLE "trial_claims"
          ADD CONSTRAINT "${name}" FOREIGN KEY ("${column}")
          REFERENCES "${table}" ("id")
      `);
    }
    // Live duplicates by email would block the old index: release the later ones.
    await queryRunner.query(`
      UPDATE "trial_claims" t SET "status" = 'released'
       WHERE "status" <> 'released'
         AND EXISTS (SELECT 1 FROM "trial_claims" o
                      WHERE o."email_normalized" = t."email_normalized"
                        AND o."status" <> 'released'
                        AND (o."created_at", o."id") < (t."created_at", t."id"))
    `);
    await queryRunner.query(`
      UPDATE "trial_claims" t SET "status" = 'released'
       WHERE "status" <> 'released' AND "phone_normalized" IS NOT NULL
         AND EXISTS (SELECT 1 FROM "trial_claims" o
                      WHERE o."phone_normalized" = t."phone_normalized"
                        AND o."status" <> 'released'
                        AND (o."created_at", o."id") < (t."created_at", t."id"))
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_trial_claims_email"
        ON "trial_claims" ("email_normalized") WHERE "status" <> 'released'
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_trial_claims_phone"
        ON "trial_claims" ("phone_normalized")
        WHERE "status" <> 'released' AND "phone_normalized" IS NOT NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "trial_claims"
        DROP COLUMN IF EXISTS "release_reason",
        DROP COLUMN IF EXISTS "source",
        DROP COLUMN IF EXISTS "tax_id_normalized",
        ALTER COLUMN "email_normalized" SET NOT NULL,
        ALTER COLUMN "company_id" SET NOT NULL,
        ALTER COLUMN "user_id" SET NOT NULL
    `);
  }
}

/**
 * Self-contained copy of trialEmailKey (common/validation/contact-normalize.ts)
 * as it was when this migration was written. A migration must not change
 * meaning when application code later does.
 */
function trialEmailKey(raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const at = email.lastIndexOf('@');
  let local = email.slice(0, at);
  let domain = email.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
    domain = 'gmail.com';
  }
  return local ? `${local}@${domain}` : null;
}
