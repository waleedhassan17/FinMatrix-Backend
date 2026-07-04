import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Operational audit trail (phase3 Chunk 1): rider password resets,
 * deactivations and similar admin actions must be audited.
 * Additive + idempotent.
 */
export class OperationalAuditEvents1783710000000 implements MigrationInterface {
  name = 'OperationalAuditEvents1783710000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "operational_audit_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "company_id" uuid NOT NULL,
        "actor_user_id" uuid,
        "action" varchar(64) NOT NULL,
        "target_type" varchar(64) NOT NULL,
        "target_id" varchar(64),
        "details" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now()
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_op_audit_company_created"
        ON "operational_audit_events" ("company_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_op_audit_company_target"
        ON "operational_audit_events" ("company_id", "target_type", "target_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "operational_audit_events"`);
  }
}
