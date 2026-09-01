import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Staff requests awaiting the owner's decision.
 *
 * A row here is a request to perform an action, NOT the action. It writes no
 * general-ledger rows, no journal entry, no purchase order: `payload` holds
 * the original request body, replayed against the owning service only when the
 * owner approves. That is the property the whole feature rests on — a pending
 * request has nothing to unwind if it is rejected, cancelled, or ignored.
 *
 * `status` includes `approving`, which is a claim rather than a resting state.
 * Approving dispatches to services that each open their own transaction, so
 * they cannot be enrolled in one outer transaction with this row. Instead the
 * row is moved pending → approving by a conditional UPDATE that only one
 * caller can win, and on to approved once the work is done. Two concurrent
 * approvals therefore cannot both post. See ApprovalsService.decide.
 *
 * No foreign key to `companies`: the codebase scopes by company_id without
 * one throughout, and matching that is better than being locally stricter.
 */
export class ApprovalRequests1787250000000 implements MigrationInterface {
  name = 'ApprovalRequests1787250000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS "approval_requests" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "company_id" uuid NOT NULL,
        "type" character varying(32) NOT NULL,
        "status" character varying(16) NOT NULL DEFAULT 'pending',
        "payload" jsonb NOT NULL,
        "summary" text NOT NULL,
        "reason" text,
        "requested_by" uuid NOT NULL,
        "reviewed_by" uuid,
        "reviewer_role" character varying(16),
        "reviewed_at" TIMESTAMP WITH TIME ZONE,
        "reviewer_comment" text,
        "journal_entry_id" uuid,
        "result_id" uuid,
        "last_error" text,
        CONSTRAINT "PK_approval_requests" PRIMARY KEY ("id")
      )
    `);

    // The inbox query: pending requests for a company.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_approval_requests_company_status"
        ON "approval_requests" ("company_id", "status")
    `);
    // "My requests": a staff member sees only their own.
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_approval_requests_company_requester"
        ON "approval_requests" ("company_id", "requested_by")
    `);
    await queryRunner.query(`
      CREATE INDEX IF NOT EXISTS "IDX_approval_requests_company_id"
        ON "approval_requests" ("company_id")
    `);

    // Belt and braces behind the application's own validation: a typo in a
    // dispatcher key must not be able to persist an unroutable request.
    await queryRunner.query(`
      ALTER TABLE "approval_requests"
        ADD CONSTRAINT "CHK_approval_requests_type" CHECK ("type" IN (
          'adjustment','journal','credit_memo','vendor_credit',
          'void','bill_payment','po','delivery_undo'
        ))
    `);
    await queryRunner.query(`
      ALTER TABLE "approval_requests"
        ADD CONSTRAINT "CHK_approval_requests_status" CHECK ("status" IN (
          'pending','approving','approved','rejected','cancelled'
        ))
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS "approval_requests"`);
  }
}
