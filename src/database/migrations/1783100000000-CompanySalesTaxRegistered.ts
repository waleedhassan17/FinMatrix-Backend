import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FinMatrix.md §21 — recoverable input tax. Flags a company as GST/sales-tax
 * registered so input tax on bills is posted to Sales Tax Recoverable (1300)
 * instead of being rolled into the expense/inventory line. Idempotent.
 */
export class CompanySalesTaxRegistered1783100000000
  implements MigrationInterface
{
  name = 'CompanySalesTaxRegistered1783100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies"
        ADD COLUMN IF NOT EXISTS "sales_tax_registered" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "companies" DROP COLUMN IF EXISTS "sales_tax_registered"
    `);
  }
}
