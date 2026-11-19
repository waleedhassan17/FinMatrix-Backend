import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * System accounts are found by role, not by number.
 *
 * Automatic posting used to find Receivables, Inventory, Sales Tax Payable
 * and the rest by their default numbers (1100, 1200, 2300…), so those numbers
 * could never change — and a business moving from Peachtree, QuickBooks or
 * Sage had to give up its own chart. Each system account now carries its role
 * (accounts.system_role); its number and name may change, the role never.
 *
 * Backfill: in every company, the account at a role's default number takes
 * that role — exactly the account automatic posting used until now. The list
 * mirrors SYSTEM_ACCOUNT_DEFS in accounts.constants.ts and is frozen here, as
 * a migration must be.
 *
 * Re-runnable: the column and index are created if missing, and only
 * accounts without a role are given one.
 */
const ROLES: Array<[role: string, defaultNumber: string]> = [
  ['cash', '1000'],
  ['bank', '1010'],
  ['accounts_receivable', '1100'],
  ['inventory', '1200'],
  ['goods_in_transit', '1250'],
  ['input_tax', '1300'],
  ['accounts_payable', '2000'],
  ['grni', '2050'],
  ['sales_tax_payable', '2300'],
  ['payroll_liabilities', '2310'],
  ['customer_advances', '2400'],
  ['owner_equity', '3000'],
  ['retained_earnings', '3100'],
  ['opening_balance_equity', '3900'],
  ['migration_clearing', '3950'],
  ['sales_revenue', '4000'],
  ['cogs', '5000'],
  ['shrinkage_damage', '5400'],
  ['shrinkage_theft', '5410'],
  ['shrinkage_obsolescence', '5420'],
  ['inventory_count_variance', '5430'],
  ['salary_expense', '6200'],
  ['inventory_adjustment', '6400'],
];

export class AccountSystemRoles1791100000000 implements MigrationInterface {
  name = 'AccountSystemRoles1791100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "accounts" ADD COLUMN IF NOT EXISTS "system_role" character varying(40)`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS "UQ_accounts_company_system_role" ON "accounts" ("company_id", "system_role") WHERE "system_role" IS NOT NULL`,
    );
    for (const [role, number] of ROLES) {
      // A company already holding the role (a re-run) is skipped.
      await queryRunner.query(
        `UPDATE "accounts" a SET "system_role" = $1
          WHERE a."account_number" = $2 AND a."system_role" IS NULL
            AND NOT EXISTS (SELECT 1 FROM "accounts" b WHERE b."company_id" = a."company_id" AND b."system_role" = $1)`,
        [role, number],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "UQ_accounts_company_system_role"`,
    );
    await queryRunner.query(
      `ALTER TABLE "accounts" DROP COLUMN IF EXISTS "system_role"`,
    );
  }
}
