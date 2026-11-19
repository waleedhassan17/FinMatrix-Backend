import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Company backup: one row per backup an owner asked for.
 *
 * The row is the job. POST /data-portability/exports inserts it as `queued`;
 * the export worker (CompanyExportWorker) claims `queued` rows with
 * FOR UPDATE SKIP LOCKED — the same pattern as outbound_messages — builds the
 * ZIP, stores it and marks the row `ready` (or `failed` with the reason). An
 * hourly sweep deletes the file once `expires_at` has passed and marks the
 * row `expired`, so the list an owner sees is also the history of what was
 * downloaded when.
 *
 * `size_bytes` is bigint: a backup of a busy distributor's books with its
 * photos is well past what integer holds. No foreign key to `companies`,
 * matching the rest of the schema.
 */
export class CompanyExports1790700000000 implements MigrationInterface {
  name = 'CompanyExports1790700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "company_exports" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "company_id" uuid NOT NULL,
        "requested_by" uuid NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'queued',
        "include_xlsx" boolean NOT NULL DEFAULT false,
        "as_of" date NOT NULL,
        "file_name" character varying(160) NOT NULL,
        "storage_key" character varying(255),
        "size_bytes" bigint,
        "error" text,
        "attempts" integer NOT NULL DEFAULT 0,
        "summary" jsonb,
        "started_at" TIMESTAMP WITH TIME ZONE,
        "completed_at" TIMESTAMP WITH TIME ZONE,
        "expires_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_company_exports" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_company_exports_company_created"
         ON "company_exports" ("company_id", "created_at")`,
    );
    // The worker's claim and the expiry sweep both read by status.
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_company_exports_status_created"
         ON "company_exports" ("status", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_company_exports_status_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_company_exports_company_created"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "company_exports"`);
  }
}
