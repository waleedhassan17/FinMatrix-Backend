import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Book a Demo.
 *
 *   demo_requests       — public booking requests: the prospect, the slot they
 *                         prefer, attribution, and the sales pipeline (status,
 *                         schedule, meeting link, assignee, conversion).
 *   demo_request_notes  — internal notes (cascade with the request).
 *   users.signup_ref    — `demo_<id>` when an owner signs up from a demo's
 *                         trial invite, so their company is linked to it.
 *
 * New tables and one nullable column; the old release never touches them.
 */
export class DemoRequests1791600000000 implements MigrationInterface {
  name = 'DemoRequests1791600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "demo_requests" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        "full_name" varchar(80) NOT NULL,
        "business_name" varchar(120) NOT NULL,
        "phone_e164" varchar(20) NOT NULL,
        "email" varchar(255) NOT NULL,
        "email_key" varchar(255) NOT NULL,
        "city" varchar(80) NOT NULL,
        "business_type" varchar(32) NOT NULL,
        "team_size" varchar(8),
        "current_system" varchar(24),
        "language" varchar(2) NOT NULL DEFAULT 'en',
        "preferred_slot_at" TIMESTAMPTZ NOT NULL,
        "message" text,
        "consent_at" TIMESTAMPTZ NOT NULL,
        "utm" jsonb,
        "referrer" varchar(500),
        "landing_path" varchar(300),
        "ip_hash" varchar(64),
        "source" varchar(24) NOT NULL DEFAULT 'website',
        "status" varchar(16) NOT NULL DEFAULT 'new',
        "scheduled_at" TIMESTAMPTZ,
        "meeting_link" varchar(500),
        "assigned_to" uuid,
        "lost_reason" text,
        "converted_company_id" uuid,
        "converted_at" TIMESTAMPTZ,
        "invite_sent_at" TIMESTAMPTZ,
        "reminder_sent_at" TIMESTAMPTZ,
        "ics_sequence" integer NOT NULL DEFAULT 0,
        CONSTRAINT "pk_demo_requests" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_demo_requests_status" CHECK ("status" IN
          ('new','contacted','scheduled','rescheduled','completed','no_show','converted','lost')),
        CONSTRAINT "CHK_demo_requests_language" CHECK ("language" IN ('en','ur'))
      )
    `);
    for (const [name, cols] of [
      ['idx_demo_requests_status', '"status", "created_at"'],
      ['idx_demo_requests_email_key', '"email_key"'],
      ['idx_demo_requests_phone', '"phone_e164"'],
      ['idx_demo_requests_slot', '"preferred_slot_at"'],
      ['idx_demo_requests_scheduled', '"scheduled_at"'],
    ] as const) {
      await queryRunner.query(
        `CREATE INDEX IF NOT EXISTS "${name}" ON "demo_requests" (${cols})`,
      );
    }
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "demo_request_notes" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "demo_request_id" uuid NOT NULL,
        "author_id" uuid,
        "body" text NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT "pk_demo_request_notes" PRIMARY KEY ("id"),
        CONSTRAINT "fk_demo_request_notes_request" FOREIGN KEY ("demo_request_id")
          REFERENCES "demo_requests" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "idx_demo_request_notes_request"
        ON "demo_request_notes" ("demo_request_id", "created_at")
    `);
    await queryRunner.query(
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "signup_ref" varchar(64)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN IF EXISTS "signup_ref"`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "demo_request_notes"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "demo_requests"`);
  }
}
