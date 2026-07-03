import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Payment screenshots must survive dyno restarts — Heroku's filesystem is
 * ephemeral, so the disk copy written by StorageService disappears on every
 * restart/deploy and the super-admin review screen 404s. Store the bytes in
 * Postgres (small volume: one image per payment submission, ≤8 MB each).
 * Additive + idempotent; never touches existing rows.
 */
export class PaymentScreenshotData1783600000000 implements MigrationInterface {
  name = 'PaymentScreenshotData1783600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "platform_payment_submissions"
        ADD COLUMN IF NOT EXISTS "screenshot_data" bytea
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "platform_payment_submissions"
        DROP COLUMN IF EXISTS "screenshot_data"
    `);
  }
}
