import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Require evidence behind every bill payment.
 *
 * A bill payment moves money out of a bank account and posts Dr Accounts
 * Payable / Cr Bank, but until now it could be recorded with nothing to back
 * it up — no bank confirmation, no transfer screenshot, no photo of the signed
 * cash voucher.
 *
 * bill_payment_proofs holds the uploaded file's metadata. It exists as its own
 * table rather than columns on bill_payments because the upload has to happen
 * BEFORE the payment does: StorageService bakes a public path into the URL it
 * returns, and a payment has no id to build that path from until it is
 * created. The row also carries company_id, which stored_files does not — that
 * is what makes it possible to reject a proof belonging to another tenant.
 *
 * proof_storage_key / proof_url on bill_payments are the copy taken when a
 * payment claims a proof. Both are NULLABLE and existing rows are left null:
 * those payments predate the rule, and the bill detail screen has to keep
 * rendering them.
 */
export class BillPaymentProof1787230000000 implements MigrationInterface {
  name = 'BillPaymentProof1787230000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "bill_payment_proofs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "company_id" uuid NOT NULL,
        "storage_key" character varying(255) NOT NULL,
        "url" character varying(512) NOT NULL,
        "mime_type" character varying(128) NOT NULL,
        "original_name" character varying(255) NOT NULL,
        "size" integer NOT NULL,
        "uploaded_by" uuid NOT NULL,
        "consumed_by_payment_id" uuid,
        CONSTRAINT "PK_bill_payment_proofs" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_bill_payment_proofs_company_id"
        ON "bill_payment_proofs" ("company_id")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_bill_payment_proofs_company_created"
        ON "bill_payment_proofs" ("company_id", "created_at")
    `);

    await queryRunner.query(`
      ALTER TABLE "bill_payments"
        ADD COLUMN IF NOT EXISTS "proof_storage_key" character varying(255)
    `);
    await queryRunner.query(`
      ALTER TABLE "bill_payments"
        ADD COLUMN IF NOT EXISTS "proof_url" character varying(512)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "bill_payments" DROP COLUMN IF EXISTS "proof_url"`,
    );
    await queryRunner.query(
      `ALTER TABLE "bill_payments" DROP COLUMN IF EXISTS "proof_storage_key"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_bill_payment_proofs_company_created"`,
    );
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_bill_payment_proofs_company_id"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "bill_payment_proofs"`);
  }
}
