import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Durable Postgres file storage (phase3 Chunk 1): proof-of-delivery photos
 * must survive dyno restarts. Used when Cloudinary is not configured or an
 * upload to it fails. Additive + idempotent.
 */
export class StoredFiles1783720000000 implements MigrationInterface {
  name = 'StoredFiles1783720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "stored_files" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "bucket" varchar(64) NOT NULL,
        "mime_type" varchar(128) NOT NULL,
        "original_name" varchar(255) NOT NULL,
        "size" integer NOT NULL,
        "data" bytea NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_stored_files_bucket_created"
        ON "stored_files" ("bucket", "created_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "stored_files"`);
  }
}
