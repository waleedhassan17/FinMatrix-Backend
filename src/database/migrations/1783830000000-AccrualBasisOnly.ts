import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * G8 — state the reporting basis instead of leaving it unset.
 *
 * companies.accounting_method accepted 'cash' or 'accrual' and was NULL on
 * every company. reports.service.ts never read it: all statements derive from
 * general_ledger, which recognises revenue at invoice date and expense at bill
 * date, so they were accrual regardless of what the column said.
 *
 * Backfill the column to the basis actually in force. The column is kept
 * rather than dropped so a genuine cash-basis switch can use it later; what is
 * removed is the ability to select a basis that does nothing.
 *
 * Additive and idempotent.
 */
export class AccrualBasisOnly1783830000000 implements MigrationInterface {
  name = 'AccrualBasisOnly1783830000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "companies"
         SET "accounting_method" = 'accrual'
       WHERE "accounting_method" IS DISTINCT FROM 'accrual'
    `);
  }

  public async down(): Promise<void> {
    // Nothing to restore: the previous values were NULL or a basis the
    // reports never honoured.
  }
}
