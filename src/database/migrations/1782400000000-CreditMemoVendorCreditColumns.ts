import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase B — Credit Memos & Vendor Credits. The base tables already exist from
 * InitialSchema with a minimal column set; add the document number, status, and
 * created_by columns the Phase B entities/services need. Idempotent.
 */
export class CreditMemoVendorCreditColumns1782400000000 implements MigrationInterface {
  name = 'CreditMemoVendorCreditColumns1782400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "credit_memos"
        ADD COLUMN IF NOT EXISTS "credit_memo_number" character varying(32),
        ADD COLUMN IF NOT EXISTS "status" character varying(16) NOT NULL DEFAULT 'open',
        ADD COLUMN IF NOT EXISTS "created_by" uuid
    `);
    await queryRunner.query(`
      ALTER TABLE "vendor_credits"
        ADD COLUMN IF NOT EXISTS "vendor_credit_number" character varying(32),
        ADD COLUMN IF NOT EXISTS "status" character varying(16) NOT NULL DEFAULT 'open',
        ADD COLUMN IF NOT EXISTS "created_by" uuid
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_credit_memos_company_status" ON "credit_memos" ("company_id","status")`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_vendor_credits_company_status" ON "vendor_credits" ("company_id","status")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "credit_memos"
        DROP COLUMN IF EXISTS "credit_memo_number",
        DROP COLUMN IF EXISTS "status",
        DROP COLUMN IF EXISTS "created_by"
    `);
    await queryRunner.query(`
      ALTER TABLE "vendor_credits"
        DROP COLUMN IF EXISTS "vendor_credit_number",
        DROP COLUMN IF EXISTS "status",
        DROP COLUMN IF EXISTS "created_by"
    `);
  }
}
