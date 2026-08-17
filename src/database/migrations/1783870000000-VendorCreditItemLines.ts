import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Let a vendor credit say WHICH goods went back to the supplier.
 *
 * A purchase return is `Dr Accounts Payable / Cr Inventory`: the supplier owes
 * us money and the stock leaves our shelf. The implementation posted
 * `Dr A/P / Cr COGS` and never touched stock, so returned goods stayed
 * capitalised in Inventory forever while COGS was credited for goods that were
 * never sold — cost of sales understated, inventory overstated, both
 * permanently.
 *
 * It could not have credited Inventory as it stood: the line had only
 * `{description, amount}`, so there was no quantity to relieve. Crediting 1200
 * without moving `SUM(qty × unit_cost)` is exactly the subledger drift
 * invariant I13 exists to catch — which is presumably why the original quietly
 * retargeted to COGS instead.
 *
 * Both columns are nullable: a vendor credit for freight or a price adjustment
 * has no item, keeps its expense account, and posts exactly as before.
 * Additive and idempotent; existing rows are untouched.
 */
export class VendorCreditItemLines1783870000000 implements MigrationInterface {
  name = 'VendorCreditItemLines1783870000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "vendor_credit_lines"
        ADD COLUMN IF NOT EXISTS "item_id" uuid NULL
    `);
    await queryRunner.query(`
      ALTER TABLE "vendor_credit_lines"
        ADD COLUMN IF NOT EXISTS "quantity" numeric(18,4) NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vendor_credit_lines" DROP COLUMN IF EXISTS "quantity"`);
    await queryRunner.query(`ALTER TABLE "vendor_credit_lines" DROP COLUMN IF EXISTS "item_id"`);
  }
}
