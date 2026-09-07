import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two more things a staff member asks for rather than does: raising an invoice,
 * and receiving a customer payment.
 *
 * Both were value IN and deliberately direct — "staff run the day-to-day, and
 * nothing waits on the owner". The owner has since asked to sign off billing
 * and cash receipts too, so the gate moves and this constraint has to follow.
 *
 * `type` is varchar(32) guarded by a CHECK, not a Postgres enum, so this is a
 * drop and re-add rather than ALTER TYPE ... ADD VALUE — and it carries none of
 * the "cannot use a new enum value in the transaction that added it" trouble
 * that would have. The constraint is the belt-and-braces the original migration
 * describes: without widening it, a perfectly valid request fails at the
 * database while TypeScript is satisfied.
 */
export class InvoiceAndPaymentApprovals1787300000000 implements MigrationInterface {
  name = 'InvoiceAndPaymentApprovals1787300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
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

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rows of the two new types would violate the narrower constraint, so they
    // go first. They are requests, not documents: a pending one has posted
    // nothing, and an approved one already produced its invoice or payment,
    // which is untouched by this.
    await queryRunner.query(`
      DELETE FROM "approval_requests" WHERE "type" IN ('invoice','invoice_payment')
    `);
    await queryRunner.query(`
      ALTER TABLE "approval_requests"
        DROP CONSTRAINT IF EXISTS "CHK_approval_requests_type"
    `);
    await queryRunner.query(`
      ALTER TABLE "approval_requests"
        ADD CONSTRAINT "CHK_approval_requests_type" CHECK ("type" IN (
          'adjustment','journal','credit_memo','vendor_credit',
          'void','bill_payment','po','delivery_undo'
        ))
    `);
  }
}
