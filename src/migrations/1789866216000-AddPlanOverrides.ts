import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * plan_overrides: the admin console's edits to the plan catalogue.
 *
 * The catalogue itself stays in billing/plan-config.ts. This table layers on
 * top, so a plan with no row here resolves exactly as it did before this
 * migration -- which is also the fallback if anything goes wrong with it.
 *
 * Primary key is the plan KEY, not a UUID, because that key is what every
 * company row already stores and what the config is indexed by.
 *
 * Every value column is nullable: NULL means "no opinion, use the config".
 * That is what lets an admin change a price without restating the rider
 * limit, and what makes reverting one field a matter of writing NULL rather
 * than having to know the original value.
 */
export class AddPlanOverrides1789866216000 implements MigrationInterface {
  name = 'AddPlanOverrides1789866216000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "plan_overrides" (
        "planKey" character varying(64) NOT NULL,
        "label" character varying(120),
        "monthlyMinorUnits" integer,
        "priceMinorUnits" integer,
        "deliveryPersonnelLimit" integer,
        "isOffered" boolean,
        "updatedBy" uuid,
        "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_plan_overrides" PRIMARY KEY ("planKey")
      )
    `);
    // Prices are in MINOR UNITS and a negative one would be charged. The
    // service validates too; this is the backstop for anything writing
    // directly to the database.
    await queryRunner.query(`
      ALTER TABLE "plan_overrides"
      ADD CONSTRAINT "CHK_plan_overrides_nonneg" CHECK (
        ("monthlyMinorUnits" IS NULL OR "monthlyMinorUnits" >= 0) AND
        ("priceMinorUnits" IS NULL OR "priceMinorUnits" >= 0) AND
        ("deliveryPersonnelLimit" IS NULL OR "deliveryPersonnelLimit" >= 0)
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Dropping this returns every plan to its configured price, which is the
    // state before the feature existed -- no data loss that matters, because
    // the catalogue was never stored here in the first place.
    await queryRunner.query(`DROP TABLE IF EXISTS "plan_overrides"`);
  }
}
