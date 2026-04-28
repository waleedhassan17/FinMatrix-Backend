import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds bill-photo capture columns to deliveries, extends
 * inventory_update_requests with proof / snapshot / review fields,
 * adds item_name to lines, and creates the audit-entries table.
 */
export class BillPhotoCaptureAndApproval1777612800000 implements MigrationInterface {
  name = 'BillPhotoCaptureAndApproval1777612800000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ---------------------------------------------------------------
    // 1. deliveries — bill-photo columns
    // ---------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "deliveries"
        ADD COLUMN IF NOT EXISTS "bill_photo_url"         text,
        ADD COLUMN IF NOT EXISTS "bill_photo_storage_key"  text,
        ADD COLUMN IF NOT EXISTS "bill_photo_captured_at"  TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "bill_signed_by"          character varying(200)
    `);

    // ---------------------------------------------------------------
    // 2. inventory_update_requests — new columns
    // ---------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "inventory_update_requests"
        ADD COLUMN IF NOT EXISTS "delivery_reference"            character varying(64),
        ADD COLUMN IF NOT EXISTS "personnel_name"                character varying(200),
        ADD COLUMN IF NOT EXISTS "route_label"                   character varying(200),
        ADD COLUMN IF NOT EXISTS "shadow_status"                 character varying(16) NOT NULL DEFAULT 'pending',
        ADD COLUMN IF NOT EXISTS "reviewer_comment"              text,
        ADD COLUMN IF NOT EXISTS "proof_signed_by"               character varying(200),
        ADD COLUMN IF NOT EXISTS "proof_verification_method"     character varying(32) NOT NULL DEFAULT 'bill_photo',
        ADD COLUMN IF NOT EXISTS "proof_verified_by"             character varying(200),
        ADD COLUMN IF NOT EXISTS "proof_verified_at"             TIMESTAMP WITH TIME ZONE,
        ADD COLUMN IF NOT EXISTS "proof_bill_photo_url"          text,
        ADD COLUMN IF NOT EXISTS "proof_bill_photo_storage_key"  text,
        ADD COLUMN IF NOT EXISTS "proof_bill_photo_captured_at"  TIMESTAMP WITH TIME ZONE
    `);

    // ---------------------------------------------------------------
    // 3. inventory_update_request_lines — add item_name
    // ---------------------------------------------------------------
    await queryRunner.query(`
      ALTER TABLE "inventory_update_request_lines"
        ADD COLUMN IF NOT EXISTS "item_name" character varying(200)
    `);

    // ---------------------------------------------------------------
    // 4. inventory_approval_audit_entries — new table
    // ---------------------------------------------------------------
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "inventory_approval_audit_entries" (
        "id"          uuid NOT NULL DEFAULT uuid_generate_v4(),
        "company_id"  uuid NOT NULL,
        "request_id"  uuid NOT NULL,
        "action"      character varying(16) NOT NULL,
        "reviewed_by" uuid NOT NULL,
        "details"     text,
        "created_at"  TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_inv_approval_audit_entries" PRIMARY KEY ("id")
      )
    `);

    // Indexes
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_inv_audit_request_created"
        ON "inventory_approval_audit_entries" ("request_id", "created_at")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_inv_audit_company_created"
        ON "inventory_approval_audit_entries" ("company_id", "created_at")
    `);

    // FK to requests
    await queryRunner.query(`
      ALTER TABLE "inventory_approval_audit_entries"
        ADD CONSTRAINT "FK_inv_audit_request"
        FOREIGN KEY ("request_id")
        REFERENCES "inventory_update_requests" ("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    // Index on delivery_id for requests (if missing from initial schema)
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_inv_req_delivery"
        ON "inventory_update_requests" ("delivery_id")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Reverse order
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_inv_req_delivery"`);
    await queryRunner.query(`ALTER TABLE "inventory_approval_audit_entries" DROP CONSTRAINT IF EXISTS "FK_inv_audit_request"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_inv_audit_company_created"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_inv_audit_request_created"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "inventory_approval_audit_entries"`);

    await queryRunner.query(`ALTER TABLE "inventory_update_request_lines" DROP COLUMN IF EXISTS "item_name"`);

    await queryRunner.query(`
      ALTER TABLE "inventory_update_requests"
        DROP COLUMN IF EXISTS "delivery_reference",
        DROP COLUMN IF EXISTS "personnel_name",
        DROP COLUMN IF EXISTS "route_label",
        DROP COLUMN IF EXISTS "shadow_status",
        DROP COLUMN IF EXISTS "reviewer_comment",
        DROP COLUMN IF EXISTS "proof_signed_by",
        DROP COLUMN IF EXISTS "proof_verification_method",
        DROP COLUMN IF EXISTS "proof_verified_by",
        DROP COLUMN IF EXISTS "proof_verified_at",
        DROP COLUMN IF EXISTS "proof_bill_photo_url",
        DROP COLUMN IF EXISTS "proof_bill_photo_storage_key",
        DROP COLUMN IF EXISTS "proof_bill_photo_captured_at"
    `);

    await queryRunner.query(`
      ALTER TABLE "deliveries"
        DROP COLUMN IF EXISTS "bill_photo_url",
        DROP COLUMN IF EXISTS "bill_photo_storage_key",
        DROP COLUMN IF EXISTS "bill_photo_captured_at",
        DROP COLUMN IF EXISTS "bill_signed_by"
    `);
  }
}
