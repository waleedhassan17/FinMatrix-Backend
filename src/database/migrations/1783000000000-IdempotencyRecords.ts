import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase 5 — idempotency (FinMatrixGuide §6.3). Stores the outcome of an
 * idempotent POST keyed by (company, Idempotency-Key) so retries don't
 * double-post. Idempotent migration.
 */
export class IdempotencyRecords1783000000000 implements MigrationInterface {
  name = 'IdempotencyRecords1783000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "idempotency_records" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "company_id" uuid NOT NULL,
        "idempotency_key" character varying(200) NOT NULL,
        "method" character varying(8) NOT NULL,
        "path" character varying(300) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "status_code" integer,
        "response_body" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_idempotency_records" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "IDX_idempotency_company_key"
        ON "idempotency_records" ("company_id", "idempotency_key")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "idempotency_records"`);
  }
}
