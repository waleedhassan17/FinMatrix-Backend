import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Customer record management (phase3 Chunk 1):
 *  - contact_person / tax_id: the app's customer form always offered these
 *    fields but the API whitelisted them away, silently losing the input.
 *  - shipping_lat / shipping_lng / shipping_geocoded_at: geocoded shipping
 *    address, used as the delivery-destination fallback when a delivery's
 *    own geocode fails.
 * Additive + idempotent; never touches existing rows.
 */
export class CustomerRecordFields1783700000000 implements MigrationInterface {
  name = 'CustomerRecordFields1783700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "customers"
        ADD COLUMN IF NOT EXISTS "contact_person" varchar(200),
        ADD COLUMN IF NOT EXISTS "tax_id" varchar(64),
        ADD COLUMN IF NOT EXISTS "shipping_lat" double precision,
        ADD COLUMN IF NOT EXISTS "shipping_lng" double precision,
        ADD COLUMN IF NOT EXISTS "shipping_geocoded_at" timestamptz
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "customers"
        DROP COLUMN IF EXISTS "contact_person",
        DROP COLUMN IF EXISTS "tax_id",
        DROP COLUMN IF EXISTS "shipping_lat",
        DROP COLUMN IF EXISTS "shipping_lng",
        DROP COLUMN IF EXISTS "shipping_geocoded_at"
    `);
  }
}
