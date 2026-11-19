import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Large, resumable uploads for the Migration Center (a Peachtree backup is
 * hundreds of MB).
 *
 * migration_uploads        one upload session: the file, its declared size,
 *                          how far it has got, and the background read.
 * migration_upload_parts   the file in 8 MB pieces, each sent in a request
 *                          of its own. Held only until the background reader
 *                          has read the file, then deleted.
 *
 * migration_files.size_bytes becomes bigint: an upload may exceed 2 GiB's
 * integer range on a raised limit. No data changes; no foreign key to
 * `companies`, matching the rest of the schema.
 */
export class MigrationLargeUploads1790900000000 implements MigrationInterface {
  name = 'MigrationLargeUploads1790900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "migration_uploads" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "company_id" uuid NOT NULL,
        "batch_id" uuid NOT NULL,
        "original_name" character varying(255) NOT NULL,
        "size_bytes" bigint NOT NULL,
        "part_size" integer NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'receiving',
        "progress" jsonb,
        "sha256" character varying(64),
        "error_code" character varying(64),
        "error" text,
        "attempts" integer NOT NULL DEFAULT 0,
        "file_id" uuid,
        "created_by" uuid NOT NULL,
        "received_at" TIMESTAMP WITH TIME ZONE,
        "started_at" TIMESTAMP WITH TIME ZONE,
        "finished_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_migration_uploads" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_migration_uploads_batch" ON "migration_uploads" ("batch_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_migration_uploads_status" ON "migration_uploads" ("status", "updated_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_migration_uploads_company_id" ON "migration_uploads" ("company_id")`,
    );
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "migration_upload_parts" (
        "upload_id" uuid NOT NULL,
        "part_no" integer NOT NULL,
        "size_bytes" integer NOT NULL,
        "data" bytea NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_migration_upload_parts" PRIMARY KEY ("upload_id", "part_no"),
        CONSTRAINT "FK_migration_upload_parts_upload" FOREIGN KEY ("upload_id")
          REFERENCES "migration_uploads" ("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(
      `ALTER TABLE "migration_files" ALTER COLUMN "size_bytes" TYPE bigint`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "migration_upload_parts"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "migration_uploads"`);
    // Values above the integer range would not fit back; none can exist
    // without the uploads this migration added.
    await queryRunner.query(
      `ALTER TABLE "migration_files" ALTER COLUMN "size_bytes" TYPE integer`,
    );
  }
}
