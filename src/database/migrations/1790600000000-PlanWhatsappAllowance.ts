import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * plan_overrides gains the WhatsApp allowance: how many messages a month
 * FinMatrix sends (and pays Meta for) for one company on a plan.
 *
 * NULL means "no opinion, use the config" (billing/plan-config.ts, default
 * 200), exactly like the other value columns, so existing rows are untouched.
 */
export class PlanWhatsappAllowance1790600000000 implements MigrationInterface {
  name = 'PlanWhatsappAllowance1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "plan_overrides"
        ADD COLUMN IF NOT EXISTS "whatsappMonthlyMessages" integer
    `);
    await queryRunner.query(`
      ALTER TABLE "plan_overrides"
        ADD CONSTRAINT "CHK_plan_overrides_whatsapp_nonneg"
        CHECK ("whatsappMonthlyMessages" IS NULL OR "whatsappMonthlyMessages" >= 0)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "plan_overrides" DROP CONSTRAINT IF EXISTS "CHK_plan_overrides_whatsapp_nonneg"`,
    );
    await queryRunner.query(
      `ALTER TABLE "plan_overrides" DROP COLUMN IF EXISTS "whatsappMonthlyMessages"`,
    );
  }
}
