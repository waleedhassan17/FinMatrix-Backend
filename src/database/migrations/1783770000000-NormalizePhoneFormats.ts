import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Normalise stored Pakistani phone numbers to the canonical E.164 form.
 *
 * Phone validation used to demand the dashed `+92-XXX-XXXXXXX` shape, so
 * existing rows hold a mix of `+92-300-1234567`, `0300…` and `92300…`.
 * `IsPkPhone` (src/common/validation/phone.ts) now normalises every accepted
 * input to `+92XXXXXXXXXX` before it is persisted; this back-fills the rows
 * written before that change so the column holds one format.
 *
 * Idempotent: re-running it is a no-op because already-canonical values match
 * none of the WHERE clauses. Anything unparseable (foreign numbers, junk left
 * by the old loose validators) is deliberately left untouched rather than
 * mangled — a human can fix those.
 *
 * Irreversible by design: the original formatting is not recoverable, and the
 * canonical form is valid under both the old and new rules where it matters,
 * so `down()` is a no-op.
 */
export class NormalizePhoneFormats1783770000000 implements MigrationInterface {
  name = 'NormalizePhoneFormats1783770000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['users', 'companies']) {
      // Strip the formatting characters users/importers typed, then rewrite
      // the country-code prefix. Order matters: strip first so the prefix
      // patterns below see bare digits.
      const stripped = `regexp_replace("phone", '[\\s\\-().]', '', 'g')`;

      // 1. Local form: 0XXXXXXXXX…  →  +92XXXXXXXXX…
      await queryRunner.query(`
        UPDATE "${table}"
        SET "phone" = '+92' || substring(${stripped} from 2)
        WHERE "phone" IS NOT NULL
          AND ${stripped} ~ '^0[0-9]{9,11}$'
      `);

      // 2. Country code without the plus: 92XXXXXXXXXX → +92XXXXXXXXXX
      await queryRunner.query(`
        UPDATE "${table}"
        SET "phone" = '+' || ${stripped}
        WHERE "phone" IS NOT NULL
          AND ${stripped} ~ '^92[0-9]{9,11}$'
      `);

      // 3. Already +92 but carrying dashes/spaces (the old canonical form):
      //    +92-300-1234567 → +923001234567
      await queryRunner.query(`
        UPDATE "${table}"
        SET "phone" = ${stripped}
        WHERE "phone" IS NOT NULL
          AND "phone" <> ${stripped}
          AND ${stripped} ~ '^\\+92[0-9]{9,11}$'
      `);

      // 4. Blank strings are not a phone number — the DTO now maps '' to
      //    undefined, so make the stored representation agree.
      await queryRunner.query(`
        UPDATE "${table}"
        SET "phone" = NULL
        WHERE "phone" IS NOT NULL AND btrim("phone") = ''
      `);
    }
  }

  public async down(): Promise<void> {
    // No-op: the pre-normalisation formatting cannot be reconstructed, and the
    // canonical form is accepted by the validators either way.
  }
}
