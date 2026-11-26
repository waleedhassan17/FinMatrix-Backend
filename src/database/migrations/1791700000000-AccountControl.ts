import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Super-admin account control: permanent company deletion.
 *
 *   company_deletions       — the job and the record of each deletion; no
 *                             foreign key, so it outlives the company.
 *   platform_final_backups  — the automatic backup taken before deleting a
 *                             company with posted entries (30 days, super-admin
 *                             download only).
 *
 * (User and company suspension columns arrived in 1791450000000.)
 * New tables only; the old release never touches them.
 */
export class AccountControl1791700000000 implements MigrationInterface {
  name = 'AccountControl1791700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "company_deletions" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "company_id" uuid NOT NULL,
        "company_name" varchar(200) NOT NULL,
        "requested_by" uuid NOT NULL,
        "reason" text NOT NULL,
        "allow_new_trial" boolean NOT NULL DEFAULT false,
        "is_demo" boolean NOT NULL DEFAULT false,
        "status" varchar(20) NOT NULL DEFAULT 'pending',
        "backup_required" boolean NOT NULL DEFAULT false,
        "final_backup_id" uuid,
        "row_counts" jsonb,
        "files_deleted" integer NOT NULL DEFAULT 0,
        "files_failed" integer NOT NULL DEFAULT 0,
        "users_deleted" integer NOT NULL DEFAULT 0,
        "memberships_removed" integer NOT NULL DEFAULT 0,
        "owner_email_hash" varchar(64),
        "attempts" integer NOT NULL DEFAULT 0,
        "error" text,
        "started_at" TIMESTAMPTZ,
        "finished_at" TIMESTAMPTZ,
        CONSTRAINT "pk_company_deletions" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_company_deletions_status"
          CHECK ("status" IN ('pending', 'backing_up', 'deleting', 'done', 'failed'))
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_company_deletions_status"
        ON "company_deletions" ("status", "created_at")
    `);
    // At most one live deletion per company.
    await queryRunner.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS "ux_company_deletions_live"
        ON "company_deletions" ("company_id")
        WHERE "status" IN ('pending', 'backing_up', 'deleting')
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "platform_final_backups" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "deletion_id" uuid NOT NULL,
        "company_id" uuid NOT NULL,
        "company_name" varchar(200) NOT NULL,
        "storage_key" text,
        "size_bytes" bigint NOT NULL DEFAULT 0,
        "expires_at" TIMESTAMPTZ NOT NULL,
        "deleted_at" TIMESTAMPTZ,
        CONSTRAINT "pk_platform_final_backups" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_platform_final_backups_expiry"
        ON "platform_final_backups" ("expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "platform_final_backups"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "company_deletions"`);
  }
}
