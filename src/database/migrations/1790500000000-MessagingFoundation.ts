import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * FinMatrix Connect: the server sends documents over WhatsApp.
 *
 * company_messaging_settings  one row per company that has opened the settings
 *                             (no row = Connect off; GET returns defaults).
 * outbound_messages           one row per (event, document, version, phone). A
 *                             row is written inside the same transaction as the
 *                             posting that caused it, so a rolled-back posting
 *                             leaves no row; only the dispatcher talks to Meta.
 * message_status_events       append-only provider history (sent, delivered,
 *                             read, failed) behind each message's status.
 * messaging_usage             sends per company, month and category, for the
 *                             monthly cap and the usage panel.
 *
 * customers / vendors gain a WhatsApp number of their own (backfilled from
 * `phone` with the app's rule, written in SQL below), consent, opt-out and
 * verification stamps, and a preferred language. customers also gain
 * collections_paused, which stops reminders without touching anything else.
 *
 * No foreign key to `companies`, matching the rest of the schema (see
 * 1787250000000-ApprovalRequests). Nothing here touches the ledger.
 */
export class MessagingFoundation1790500000000 implements MigrationInterface {
  name = 'MessagingFoundation1790500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "company_messaging_settings" (
        "company_id" uuid NOT NULL,
        "enabled" boolean NOT NULL DEFAULT false,
        "enabled_at" TIMESTAMP WITH TIME ZONE,
        "sender_mode" character varying(8) NOT NULL DEFAULT 'shared',
        "phone_number_id" character varying(64),
        "waba_id" character varying(64),
        "access_token_enc" text,
        "default_language" character varying(2) NOT NULL DEFAULT 'en',
        "event_rules" jsonb NOT NULL DEFAULT '${JSON.stringify(DEFAULT_EVENT_RULES)}'::jsonb,
        "quiet_hours" jsonb DEFAULT '{"start":"21:00","end":"09:00"}'::jsonb,
        "reminder_schedule" jsonb NOT NULL DEFAULT '{"beforeDue":[3],"afterDue":[0,7,15,30]}'::jsonb,
        "monthly_cap" integer,
        "contacts_opt_in_confirmed_at" TIMESTAMP WITH TIME ZONE,
        "contacts_opt_in_confirmed_by" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_company_messaging_settings" PRIMARY KEY ("company_id"),
        CONSTRAINT "CHK_cms_sender_mode" CHECK ("sender_mode" IN ('shared','own')),
        CONSTRAINT "CHK_cms_default_language" CHECK ("default_language" IN ('en','ur')),
        CONSTRAINT "CHK_cms_monthly_cap" CHECK ("monthly_cap" IS NULL OR "monthly_cap" >= 0)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "outbound_messages" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "company_id" uuid NOT NULL,
        "event_type" character varying(32) NOT NULL,
        "doc_type" character varying(32) NOT NULL,
        "doc_id" uuid NOT NULL,
        "doc_version" integer NOT NULL DEFAULT 1,
        "recipient_type" character varying(16) NOT NULL,
        "recipient_id" uuid,
        "to_phone_e164" character varying(16),
        "channel" character varying(16) NOT NULL DEFAULT 'whatsapp_api',
        "template_name" character varying(64) NOT NULL,
        "language" character varying(2) NOT NULL DEFAULT 'en',
        "params" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "attachment" jsonb,
        "media_storage_key" text,
        "status" character varying(16) NOT NULL DEFAULT 'queued',
        "provider_message_id" character varying(128),
        "attempts" integer NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "last_error" text,
        "idempotency_key" character varying(255) NOT NULL,
        "scheduled_for" TIMESTAMP WITH TIME ZONE,
        "created_by" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_outbound_messages" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_outbound_messages_idempotency_key" UNIQUE ("idempotency_key"),
        CONSTRAINT "CHK_om_recipient_type" CHECK ("recipient_type" IN ('customer','vendor','user')),
        CONSTRAINT "CHK_om_channel" CHECK ("channel" IN ('whatsapp_api','wa_link')),
        CONSTRAINT "CHK_om_status" CHECK ("status" IN (
          'queued','sending','sent','delivered','read','failed','skipped','cancelled'
        )),
        CONSTRAINT "CHK_om_attempts" CHECK ("attempts" >= 0)
      )
    `);
    // The dispatcher's claim query.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_outbound_messages_status_next"
        ON "outbound_messages" ("status", "next_attempt_at")
    `);
    // A document's timeline, and lastMessageStatus on lists.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_outbound_messages_doc"
        ON "outbound_messages" ("company_id", "doc_type", "doc_id")
    `);
    // Webhook status updates arrive keyed by the provider's id.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_outbound_messages_provider_id"
        ON "outbound_messages" ("provider_message_id")
    `);
    // Stats and the collections report read a company's recent messages.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_outbound_messages_company_created"
        ON "outbound_messages" ("company_id", "created_at")
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "message_status_events" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "message_id" uuid NOT NULL,
        "status" character varying(16) NOT NULL,
        "occurred_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "raw" jsonb,
        "error_code" character varying(32),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_message_status_events" PRIMARY KEY ("id"),
        CONSTRAINT "FK_message_status_events_message" FOREIGN KEY ("message_id")
          REFERENCES "outbound_messages" ("id") ON DELETE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_message_status_events_message"
        ON "message_status_events" ("message_id", "occurred_at")
    `);
    // Append-only: history is never rewritten. (Deletes are left to the
    // cascade from outbound_messages, which nothing in the app performs.)
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION message_status_events_append_only() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'message_status_events is append-only';
      END;
      $$ LANGUAGE plpgsql
    `);
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS "TRG_message_status_events_no_update" ON "message_status_events"
    `);
    await queryRunner.query(`
      CREATE TRIGGER "TRG_message_status_events_no_update"
        BEFORE UPDATE ON "message_status_events"
        FOR EACH ROW EXECUTE FUNCTION message_status_events_append_only()
    `);

    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "messaging_usage" (
        "company_id" uuid NOT NULL,
        "period" character varying(7) NOT NULL,
        "category" character varying(32) NOT NULL,
        "count" integer NOT NULL DEFAULT 0,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_messaging_usage" PRIMARY KEY ("company_id", "period", "category"),
        CONSTRAINT "CHK_messaging_usage_period" CHECK ("period" ~ '^[0-9]{4}-[0-9]{2}$'),
        CONSTRAINT "CHK_messaging_usage_count" CHECK ("count" >= 0)
      )
    `);

    for (const table of ['customers', 'vendors']) {
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD COLUMN IF NOT EXISTS "whatsapp_e164" character varying(16),
          ADD COLUMN IF NOT EXISTS "whatsapp_opt_in_at" TIMESTAMP WITH TIME ZONE,
          ADD COLUMN IF NOT EXISTS "whatsapp_opt_in_by" uuid,
          ADD COLUMN IF NOT EXISTS "whatsapp_opt_out" boolean NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS "whatsapp_verified_at" TIMESTAMP WITH TIME ZONE,
          ADD COLUMN IF NOT EXISTS "preferred_language" character varying(2)
      `);
      await queryRunner.query(`
        ALTER TABLE "${table}"
          ADD CONSTRAINT "CHK_${table}_preferred_language"
          CHECK ("preferred_language" IS NULL OR "preferred_language" IN ('en','ur'))
      `);
      // STOP / UNSUBSCRIBE and delivery receipts look contacts up by number.
      await queryRunner.query(`
        CREATE INDEX IF NOT EXISTS "IDX_${table}_whatsapp_e164"
          ON "${table}" ("whatsapp_e164") WHERE "whatsapp_e164" IS NOT NULL
      `);
      await queryRunner.query(backfillSql(table));
    }

    await queryRunner.query(`
      ALTER TABLE "customers"
        ADD COLUMN IF NOT EXISTS "collections_paused" boolean NOT NULL DEFAULT false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "customers" DROP COLUMN IF EXISTS "collections_paused"`,
    );
    for (const table of ['vendors', 'customers']) {
      await queryRunner.query(
        `DROP INDEX IF EXISTS "IDX_${table}_whatsapp_e164"`,
      );
      await queryRunner.query(
        `ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "CHK_${table}_preferred_language"`,
      );
      await queryRunner.query(`
        ALTER TABLE "${table}"
          DROP COLUMN IF EXISTS "preferred_language",
          DROP COLUMN IF EXISTS "whatsapp_verified_at",
          DROP COLUMN IF EXISTS "whatsapp_opt_out",
          DROP COLUMN IF EXISTS "whatsapp_opt_in_by",
          DROP COLUMN IF EXISTS "whatsapp_opt_in_at",
          DROP COLUMN IF EXISTS "whatsapp_e164"
      `);
    }
    await queryRunner.query(`DROP TABLE IF EXISTS "messaging_usage"`);
    await queryRunner.query(`DROP TABLE IF EXISTS "message_status_events"`);
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS message_status_events_append_only()`,
    );
    await queryRunner.query(`DROP TABLE IF EXISTS "outbound_messages"`);
    await queryRunner.query(
      `DROP TABLE IF EXISTS "company_messaging_settings"`,
    );
  }
}

/**
 * Per-event defaults: 'auto' sends on its own, 'manual' waits for someone to
 * press Send, 'off' never sends. Kept in step with
 * src/modules/messaging/messaging.constants.ts DEFAULT_EVENT_RULES (copied,
 * not imported: a migration must not change when application code does).
 */
const DEFAULT_EVENT_RULES = {
  invoice_issued: 'auto',
  invoice_revised: 'auto',
  invoice_cancelled: 'auto',
  payment_received: 'auto',
  po_issued: 'auto',
  po_cancelled: 'auto',
  remittance: 'auto',
  approval_pending: 'auto',
  reminder_upcoming: 'auto',
  reminder_overdue: 'auto',
  statement: 'off',
  delivery_update: 'off',
};

/**
 * The app's WhatsApp rule (src/common/utils/phone.util.ts toWhatsappE164) in
 * SQL: digits only, drop a 00 prefix, 0xxxxxxxxxx -> 92xxxxxxxxxx,
 * 3xxxxxxxxx -> 923xxxxxxxxx, keep 10..15 digits. Anything else stays NULL.
 */
function backfillSql(table: string): string {
  return `
    WITH d0 AS (
      SELECT id, regexp_replace(coalesce(phone, ''), '\\D', '', 'g') AS digits
      FROM "${table}"
      WHERE whatsapp_e164 IS NULL AND phone IS NOT NULL
    ), d1 AS (
      SELECT id, CASE WHEN digits LIKE '00%' THEN substr(digits, 3) ELSE digits END AS digits
      FROM d0
    ), d2 AS (
      SELECT id, CASE
        WHEN length(digits) = 11 AND digits LIKE '0%' THEN '92' || substr(digits, 2)
        WHEN length(digits) = 10 AND digits LIKE '3%' THEN '92' || digits
        ELSE digits END AS digits
      FROM d1
    )
    UPDATE "${table}" t
       SET whatsapp_e164 = '+' || d2.digits
      FROM d2
     WHERE t.id = d2.id AND length(d2.digits) BETWEEN 10 AND 15
  `;
}
