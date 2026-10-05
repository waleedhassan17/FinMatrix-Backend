import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Which cash or bank account a tax payment, a payroll run and a credit-memo
 * refund moved money through.
 *
 * All three posted to 1000 Cash with no choice, so a company that pays its
 * salaries from MCB and its tax from Meezan had both banks wrong and a Cash
 * account that never reconciled. Each now takes the account the money really
 * left from (Peachtree's "Cash Account"), and remembers it:
 *
 *   tax_payments.bank_account_id     the reversal of a deleted tax payment
 *                                    puts the money back where it came from
 *   payroll_runs.bank_account_id     "Paid from" on a processed run
 *   credit_memos.refund_account_id   "Refunded from" on a refunded memo
 *
 * NULL on every existing row, and that is accurate rather than missing: each
 * of them was posted against 1000 Cash, which is what a NULL is read as.
 *
 * Plain uuid columns, like payments.bank_account_id and
 * bill_payments.bank_account_id — the chart is tenant data validated in the
 * service, and no table here references accounts with a foreign key.
 *
 * The entities declare the columns too: environments running with
 * DB_SYNCHRONIZE=true drop whatever the entities do not.
 */
export class MoneyAccountChoice1790100000000 implements MigrationInterface {
  name = 'MoneyAccountChoice1790100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const { table, column } of COLUMNS) {
      await queryRunner.query(
        `ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${column}" uuid NULL`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const { table, column } of COLUMNS) {
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP COLUMN IF EXISTS "${column}"`,
      );
    }
  }
}

const COLUMNS = [
  { table: 'tax_payments', column: 'bank_account_id' },
  { table: 'payroll_runs', column: 'bank_account_id' },
  { table: 'credit_memos', column: 'refund_account_id' },
] as const;
