import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FinMatrix.md §27 — Bank Reconciliation. Adds a `reconciliations` record table
 * and `cleared` / `reconciliation_id` markers on general_ledger so cash/bank
 * rows can be matched to a bank statement. Verification/marking only — no
 * journal entries are posted. Idempotent.
 */
export class BankReconciliation1783200000000 implements MigrationInterface {
  name = 'BankReconciliation1783200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "reconciliations" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "company_id" uuid NOT NULL,
        "account_id" uuid NOT NULL,
        "statement_date" date NOT NULL,
        "statement_ending_balance" numeric(18,4) NOT NULL,
        "beginning_balance" numeric(18,4) NOT NULL DEFAULT 0,
        "cleared_balance" numeric(18,4) NOT NULL DEFAULT 0,
        "difference" numeric(18,4) NOT NULL DEFAULT 0,
        "cleared_count" integer NOT NULL DEFAULT 0,
        "status" character varying(16) NOT NULL DEFAULT 'completed',
        "notes" text,
        "created_by" uuid NOT NULL,
        "reconciled_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_reconciliations" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_reconciliations_company" ON "reconciliations" ("company_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_reconciliations_company_account_date" ON "reconciliations" ("company_id", "account_id", "statement_date")`,
    );

    await queryRunner.query(`
      ALTER TABLE "general_ledger"
        ADD COLUMN IF NOT EXISTS "cleared" boolean NOT NULL DEFAULT false
    `);
    await queryRunner.query(`
      ALTER TABLE "general_ledger"
        ADD COLUMN IF NOT EXISTS "reconciliation_id" uuid
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_general_ledger_reconciliation" ON "general_ledger" ("reconciliation_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_general_ledger_reconciliation"`);
    await queryRunner.query(`ALTER TABLE "general_ledger" DROP COLUMN IF EXISTS "reconciliation_id"`);
    await queryRunner.query(`ALTER TABLE "general_ledger" DROP COLUMN IF EXISTS "cleared"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_reconciliations_company_account_date"`);
    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_reconciliations_company"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "reconciliations"`);
  }
}
