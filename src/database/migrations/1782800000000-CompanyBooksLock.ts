import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 5 — period locking (FinMatrixGuide §6.4). A company can close its books
 * up to a date; any journal posting dated on/before that date is rejected by the
 * shared PostingService. Idempotent.
 */
export class CompanyBooksLock1782800000000 implements MigrationInterface {
  name = 'CompanyBooksLock1782800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "books_locked_until" date
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies" DROP COLUMN IF EXISTS "books_locked_until"
    `);
  }
}
