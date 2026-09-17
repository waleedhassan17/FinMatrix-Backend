import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A staff member may ask for a delivery the customer has paid for in advance;
 * the owner decides. The advance is cash in, which staff never record directly
 * (see payments.controller), so the request carries the whole delivery and
 * nothing — delivery, stock or receipt — exists until it is approved.
 *
 * Same drop-and-re-add of the CHECK as 1787300000000.
 */
export class DeliveryAdvanceApproval1787330000001 implements MigrationInterface {
  name = 'DeliveryAdvanceApproval1787330000001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "approval_requests"
        DROP CONSTRAINT IF EXISTS "CHK_approval_requests_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "approval_requests"
        ADD CONSTRAINT "CHK_approval_requests_type" CHECK ("type" IN (
          'adjustment','journal','credit_memo','vendor_credit',
          'void','bill_payment','po','invoice','invoice_payment','delivery_undo',
          'delivery_advance'
        ))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // A pending request has created nothing; an approved one already produced
    // its delivery and receipt, which this leaves untouched.
    await queryRunner.query(`
      DELETE FROM "approval_requests" WHERE "type" = 'delivery_advance'
    `);
    await queryRunner.query(`
      ALTER TABLE "approval_requests"
        DROP CONSTRAINT IF EXISTS "CHK_approval_requests_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "approval_requests"
        ADD CONSTRAINT "CHK_approval_requests_type" CHECK ("type" IN (
          'adjustment','journal','credit_memo','vendor_credit',
          'void','bill_payment','po','invoice','invoice_payment','delivery_undo'
        ))
    `);
  }
}
