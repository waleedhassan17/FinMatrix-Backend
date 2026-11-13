import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Migration Center (self-serve migration of a business's books).
 *
 * migration_batches        one row per migration attempt: source, cutover
 *                          date, the status machine, readiness, sign-off,
 *                          commit/rollback/close stamps, the certificate.
 * migration_files          the uploaded originals (StorageService key + hash).
 * migration_staging_rows   every source row as read (raw) and as understood
 *                          (normalized), with its outcome and reason — the
 *                          "every row accounted for" check reads these.
 * migration_mappings       sheet, column, value and account mappings with
 *                          confidence and origin (profile / rule / ai / user).
 * migration_issues         what the owner has to decide, grouped by code.
 * migration_profiles       confirmed mappings saved per company and source,
 *                          reused before any rule or AI runs next time.
 * migration_batch_records  every row a committed batch created or changed,
 *                          so rollback and its blocker checks need no columns
 *                          on eight unrelated tables.
 *
 * invoices / bills gain `source` ('app' | 'migration'), `legacy_ref` (the
 * number the document had in the old system) and `migration_batch_id`: a
 * migrated open item is a real document — payable through Receive payment and
 * Pay Bills — that carries no revenue, tax or stock, and these columns are how
 * the app tells it apart (void/delete refuse it; the list shows its old ref).
 *
 * Account 3950 "Migration Clearing" is created for every company that lacks
 * it (new companies get it from DEFAULT_CHART_OF_ACCOUNTS). No foreign key to
 * `companies`, matching the rest of the schema. Nothing here posts.
 */
export class MigrationFoundation1790800000000 implements MigrationInterface {
  name = 'MigrationFoundation1790800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "migration_batches" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "company_id" uuid NOT NULL,
        "source_system" character varying(32) NOT NULL,
        "cutover_date" date NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'draft',
        "readiness" integer NOT NULL DEFAULT 0,
        "checks" jsonb,
        "counts" jsonb,
        "last_error" text,
        "created_by" uuid NOT NULL,
        "signed_off_by" uuid,
        "signed_off_at" TIMESTAMP WITH TIME ZONE,
        "committed_by" uuid,
        "committed_at" TIMESTAMP WITH TIME ZONE,
        "closed_at" TIMESTAMP WITH TIME ZONE,
        "rolled_back_at" TIMESTAMP WITH TIME ZONE,
        "certificate_storage_key" character varying(255),
        "previous_books_locked_until" date,
        "ai_calls" integer NOT NULL DEFAULT 0,
        "ai_input_tokens" integer NOT NULL DEFAULT 0,
        "ai_output_tokens" integer NOT NULL DEFAULT 0,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_migration_batches" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_migration_batches_company_created" ON "migration_batches" ("company_id", "created_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "migration_files" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "company_id" uuid NOT NULL,
        "batch_id" uuid NOT NULL,
        "original_name" character varying(255) NOT NULL,
        "mime_type" character varying(128) NOT NULL,
        "size_bytes" integer NOT NULL,
        "storage_key" character varying(255) NOT NULL,
        "sha256" character varying(64) NOT NULL,
        "kind" character varying(16) NOT NULL,
        "detected" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_migration_files" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_migration_files_batch" ON "migration_files" ("batch_id")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "migration_staging_rows" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "company_id" uuid NOT NULL,
        "batch_id" uuid NOT NULL,
        "file_id" uuid,
        "sheet" character varying(64) NOT NULL,
        "row_number" integer NOT NULL,
        "row_hash" character varying(64) NOT NULL,
        "entity_type" character varying(32),
        "raw" jsonb NOT NULL,
        "normalized" jsonb,
        "outcome" character varying(16) NOT NULL DEFAULT 'pending',
        "reason" text,
        "match" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_migration_staging_rows" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_migration_staging_batch_entity" ON "migration_staging_rows" ("batch_id", "entity_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_migration_staging_batch_sheet_row" ON "migration_staging_rows" ("batch_id", "sheet", "row_number")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "migration_mappings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "company_id" uuid NOT NULL,
        "batch_id" uuid NOT NULL,
        "kind" character varying(16) NOT NULL,
        "sheet" character varying(64) NOT NULL DEFAULT '',
        "source" character varying(255) NOT NULL,
        "target" character varying(128),
        "confidence" numeric(4,3) NOT NULL DEFAULT 0,
        "origin" character varying(8) NOT NULL,
        "reason" text,
        "confirmed" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_migration_mappings" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_migration_mappings_batch_kind_sheet_source" ON "migration_mappings" ("batch_id", "kind", "sheet", "source")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "migration_issues" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "company_id" uuid NOT NULL,
        "batch_id" uuid NOT NULL,
        "code" character varying(48) NOT NULL,
        "severity" character varying(8) NOT NULL,
        "sheet" character varying(64),
        "row_number" integer,
        "field" character varying(64),
        "message" text NOT NULL,
        "options" jsonb,
        "resolution" jsonb,
        "resolved_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_migration_issues" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_migration_issues_batch_code" ON "migration_issues" ("batch_id", "code")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_migration_issues_batch_resolved" ON "migration_issues" ("batch_id", "resolved_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "migration_profiles" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "company_id" uuid NOT NULL,
        "source_system" character varying(32) NOT NULL,
        "name" character varying(120) NOT NULL,
        "mappings" jsonb NOT NULL,
        "used_count" integer NOT NULL DEFAULT 0,
        "last_used_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_migration_profiles" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_migration_profiles_company_source_name" UNIQUE ("company_id", "source_system", "name")
      )`);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "migration_batch_records" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "company_id" uuid NOT NULL,
        "batch_id" uuid NOT NULL,
        "record_type" character varying(32) NOT NULL,
        "record_id" uuid NOT NULL,
        "meta" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_migration_batch_records" PRIMARY KEY ("id")
      )`);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_migration_batch_records_batch_type" ON "migration_batch_records" ("batch_id", "record_type")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_migration_batch_records_record" ON "migration_batch_records" ("record_type", "record_id")`,
    );

    // Migrated open items are real documents with a provenance.
    for (const table of ['invoices', 'bills']) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "source" character varying(16) NOT NULL DEFAULT 'app'`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "legacy_ref" character varying(64)`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "migration_batch_id" uuid`,
      );
      // Plain, not partial: the entities declare the same index by name, and a
      // synchronized dev database keeps only what the entities can express.
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "IDX_${table}_migration_batch" ON "${table}" ("migration_batch_id")`,
      );
    }

    // 3950 Migration Clearing for every company whose chart predates it.
    await queryRunner.query(`
      INSERT INTO accounts (company_id, account_number, name, type, sub_type, parent_id, description,
                            opening_balance, balance, is_active, created_at, updated_at)
      SELECT c.id, '3950', 'Migration Clearing', 'equity', 'Other Equity', NULL, NULL,
             0, 0, true, now(), now()
        FROM companies c
       WHERE NOT EXISTS (
         SELECT 1 FROM accounts a WHERE a.company_id = c.id AND a.account_number = '3950')
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const table of ['invoices', 'bills']) {
      await queryRunner.query(
        `DROP INDEX IF EXISTS "IDX_${table}_migration_batch"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "migration_batch_id"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "legacy_ref"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "source"`,
      );
    }
    for (const table of [
      'migration_batch_records',
      'migration_profiles',
      'migration_issues',
      'migration_mappings',
      'migration_staging_rows',
      'migration_files',
      'migration_batches',
    ]) {
      await queryRunner.query(`DROP TABLE IF EXISTS "${table}"`);
    }
    // The 3950 rows stay: an account the ledger may reference is never dropped.
  }
}
