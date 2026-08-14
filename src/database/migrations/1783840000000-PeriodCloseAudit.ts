import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G4 — record WHEN the books were closed, not just through what date.
 *
 * books_locked_until says which period is shut. It does not say when the lock
 * was applied, and without that the closed-period invariant cannot be written
 * correctly.
 *
 * The audited I12 reads:
 *
 *   WHERE books_locked_until IS NOT NULL
 *     AND e.date <= c.books_locked_until
 *     AND e.status = 'posted'
 *
 * which matches EVERY entry legitimately posted before the close. Locking one
 * demo company through a month end flags 40 of its 47 entries. I12 has only
 * ever "passed" because no company had a lock set; the moment a period is
 * genuinely closed it turns into pure noise.
 *
 * What the invariant means to catch is back-dating: an entry written INTO a
 * period after that period was closed. That needs the lock timestamp, so:
 *
 *   WHERE e.date       <= c.books_locked_until   -- lands in a shut period
 *     AND e.created_at >  c.books_locked_at      -- but was written afterwards
 *
 * Additive and idempotent. Existing locks (there are none) would get the
 * current time, which is the safest reading — it treats everything already on
 * file as legitimately pre-dating the close.
 */
export class PeriodCloseAudit1783840000000 implements MigrationInterface {
  name = 'PeriodCloseAudit1783840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "books_locked_at" TIMESTAMP WITH TIME ZONE
    `);

    await queryRunner.query(`
      UPDATE "companies"
         SET "books_locked_at" = now()
       WHERE "books_locked_until" IS NOT NULL AND "books_locked_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "companies" DROP COLUMN IF EXISTS "books_locked_at"`,
    );
  }
}
