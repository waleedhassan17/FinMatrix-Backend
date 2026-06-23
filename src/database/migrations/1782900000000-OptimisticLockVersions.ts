import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 5 — optimistic locking (FinMatrixGuide §6.7). Adds a TypeORM @VersionColumn
 * to invoices and bills so two concurrent payments can't both read the same balance
 * and overpay — the second save fails with an OptimisticLockVersionMismatchError.
 * Idempotent.
 */
export class OptimisticLockVersions1782900000000 implements MigrationInterface {
  name = 'OptimisticLockVersions1782900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(
      `ALTER TABLE "bills" ADD COLUMN IF NOT EXISTS "version" integer NOT NULL DEFAULT 1`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "invoices" DROP COLUMN IF EXISTS "version"`);
    await queryRunner.query(`ALTER TABLE "bills" DROP COLUMN IF EXISTS "version"`);
  }
}
