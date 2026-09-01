import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record WHICH ROLE signed off a delivery completion.
 *
 * Approving a rider's delivery is the moment revenue posts, and it is now a
 * staff-or-admin action rather than admin-only. `reviewed_by` alone answers
 * "who", but the screen needs to show "Staff approved" versus "Owner
 * approved" — a different level of authority behind the same posting — and
 * resolving that by re-reading the reviewer's CURRENT membership would be
 * wrong: roles change, and the badge has to say what they were at the time.
 *
 * Nullable, and existing rows stay null: every approval before this migration
 * was necessarily made by an admin, but recording that as fact would be
 * inventing history. The UI reads a null as "Approved" with no role badge.
 */
export class DeliveryReviewerRole1787260000000 implements MigrationInterface {
  name = 'DeliveryReviewerRole1787260000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_update_requests"
        ADD COLUMN IF NOT EXISTS "reviewer_role" character varying(16)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_update_requests"
        DROP COLUMN IF EXISTS "reviewer_role"
    `);
  }
}
