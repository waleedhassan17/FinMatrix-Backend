import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Phase D — Payroll. `employees` and `payroll_runs` already exist from
 * InitialSchema; add the per-employee `payroll_items` (pay stub) table.
 */
export class PayrollItems1782500000000 implements MigrationInterface {
  name = 'PayrollItems1782500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "payroll_items" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "payroll_run_id" uuid NOT NULL,
        "employee_id" uuid NOT NULL,
        "hours" numeric(18,4) NOT NULL DEFAULT 0,
        "gross" numeric(18,4) NOT NULL DEFAULT 0,
        "deductions" numeric(18,4) NOT NULL DEFAULT 0,
        "net" numeric(18,4) NOT NULL DEFAULT 0,
        CONSTRAINT "PK_payroll_items" PRIMARY KEY ("id"),
        CONSTRAINT "FK_payroll_items_run" FOREIGN KEY ("payroll_run_id") REFERENCES "payroll_runs"("id") ON DELETE CASCADE
      )`);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_payroll_items_run" ON "payroll_items" ("payroll_run_id")`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "payroll_items"`);
  }
}
