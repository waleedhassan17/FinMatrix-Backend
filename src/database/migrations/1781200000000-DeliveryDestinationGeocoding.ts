import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds destination address + geocoded coordinates to deliveries so the
 * admin map can plot where each delivery needs to go (not just where the
 * personnel currently are).
 */
export class DeliveryDestinationGeocoding1781200000000 implements MigrationInterface {
  name = 'DeliveryDestinationGeocoding1781200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "deliveries"
        ADD COLUMN IF NOT EXISTS "address"      character varying(300),
        ADD COLUMN IF NOT EXISTS "dest_lat"     double precision,
        ADD COLUMN IF NOT EXISTS "dest_lng"     double precision,
        ADD COLUMN IF NOT EXISTS "geocoded_at"  TIMESTAMP WITH TIME ZONE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "deliveries"
        DROP COLUMN IF EXISTS "geocoded_at",
        DROP COLUMN IF EXISTS "dest_lng",
        DROP COLUMN IF EXISTS "dest_lat",
        DROP COLUMN IF EXISTS "address"
    `);
  }
}
