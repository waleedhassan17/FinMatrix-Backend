import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Make trial history count under the strict one-trial rule.
 *
 * Every company that has EVER trialed (`is_trial = true`) gets an `approved`
 * claim carrying all of its identities — owner user, owner email key, company
 * phone, NTN, company — unless it already has a holding claim. A company could
 * have trialed without one (a trial set by hand, or by code that predates
 * trial_claims), and without the row its owner, phone and NTN would be free to
 * trial again.
 *
 * ON CONFLICT DO NOTHING: when an identity is already held by another claim
 * (two old trials that shared a phone), this company's row is skipped rather
 * than failing the deploy — the identity is held either way. Created and
 * skipped counts are logged for the release report.
 *
 * Idempotent: a second run creates nothing. Touches no ledger or document table.
 */
export class TrialClaimBackfill1791500000000 implements MigrationInterface {
  name = 'TrialClaimBackfill1791500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: Array<{
      company_id: string;
      phone: string | null;
      tax_id: string | null;
      user_id: string | null;
      email: string | null;
      trial_started_at: Date | null;
    }> = await queryRunner.query(`
      SELECT c."id" AS company_id, c."phone", c."tax_id", u."id" AS user_id,
             u."email", c."trial_started_at"
        FROM "companies" c
        LEFT JOIN "users" u ON u."id" = c."created_by"
       WHERE c."is_trial" = true
         AND NOT EXISTS (
           SELECT 1 FROM "trial_claims" t
            WHERE t."company_id" = c."id"
              AND t."status" IN ('pending', 'approved', 'blocked'))
       ORDER BY c."trial_started_at" NULLS LAST, c."id"
    `);

    let created = 0;
    let skipped = 0;
    for (const r of rows) {
      const result: unknown[] = await queryRunner.query(
        `INSERT INTO "trial_claims"
           ("email_normalized", "phone_normalized", "tax_id_normalized",
            "company_id", "user_id", "status", "source", "decided_at")
         VALUES ($1, $2, $3, $4, $5, 'approved', 'backfill', $6)
         ON CONFLICT DO NOTHING
         RETURNING "id"`,
        [
          trialEmailKey(r.email),
          normalizePhone(r.phone),
          normalizeTaxId(r.tax_id),
          r.company_id,
          r.user_id,
          r.trial_started_at ?? new Date(),
        ],
      );
      if (result.length > 0) created += 1;
      else skipped += 1;
    }

    console.log(
      `[TrialClaimBackfill] ${rows.length} trialed compan${rows.length === 1 ? 'y' : 'ies'} ` +
        `without a claim: ${created} claim(s) created, ${skipped} skipped ` +
        `(identity already held by another claim).`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "trial_claims" WHERE "source" = 'backfill'`,
    );
  }
}

// Self-contained copies of the normalisers as they were when this migration
// was written (common/validation/contact-normalize.ts, phone.ts).

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

function normalizePhone(raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.replace(/[\s\-().]/g, '');
  if (s === '') return null;
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (/^0\d+$/.test(s)) s = `+92${s.slice(1)}`;
  else if (/^92\d+$/.test(s)) s = `+${s}`;
  const mobile = /^\+923\d{9}$/.test(s);
  const landline = /^\+92(?!3)[2-9]\d{8,10}$/.test(s);
  return mobile || landline ? s : null;
}

function normalizeTaxId(raw: string | null): string | null {
  if (typeof raw !== 'string') return null;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 5 ? digits : null;
}
