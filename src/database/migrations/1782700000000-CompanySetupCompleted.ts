import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 4 — guided first-run setup (FinMatrixGuide §5.7). Tracks whether a
 * company has finished (or dismissed) the dashboard setup checklist so it can
 * be hidden once done. Idempotent.
 */
export class CompanySetupCompleted1782700000000 implements MigrationInterface {
  name = 'CompanySetupCompleted1782700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "setup_completed" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies" DROP COLUMN IF EXISTS "setup_completed"
    `);
  }
}
