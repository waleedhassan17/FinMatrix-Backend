import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * phase1.md — Delivery ↔ Ledger link (Goods in Transit model).
 *
 * deliveries:
 *   paid_status            rider's PAID/NOT PAID flag ('paid' | 'unpaid')
 *   prepaid                sale was paid before dispatch (Invoice+Payment at Stage 1)
 *   sales_order_id         non-posting Sales Order created at assignment
 *   invoice_id             invoice created at approval (or at Stage 1 when prepaid)
 *   git_journal_entry_id   Stage-1 Dr Goods in Transit / Cr Inventory entry
 *   stock_committed_at     idempotency guard: stock moved to 1250 exactly once
 *   ledger_status          'none' | 'in_transit' | 'committed' | 'returned'
 *
 * delivery_items:
 *   unit_cost              weighted-average cost FROZEN at dispatch so the Stage-3
 *                          relief of 1250 matches the Stage-1 debit to the paisa.
 *
 * Additive + idempotent.
 */
export class DeliveryLedgerLink1783740000000 implements MigrationInterface {
  name = 'DeliveryLedgerLink1783740000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "deliveries"
        ADD COLUMN IF NOT EXISTS "paid_status" varchar(8),
        ADD COLUMN IF NOT EXISTS "prepaid" boolean NOT NULL DEFAULT false,
        ADD COLUMN IF NOT EXISTS "sales_order_id" uuid,
        ADD COLUMN IF NOT EXISTS "invoice_id" uuid,
        ADD COLUMN IF NOT EXISTS "git_journal_entry_id" uuid,
        ADD COLUMN IF NOT EXISTS "stock_committed_at" timestamptz,
        ADD COLUMN IF NOT EXISTS "ledger_status" varchar(16) NOT NULL DEFAULT 'none'
    `);
    await queryRunner.query(`
      ALTER TABLE "delivery_items"
        ADD COLUMN IF NOT EXISTS "unit_cost" numeric(18,4) NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS "tax_rate" numeric(18,4) NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "deliveries"
        DROP COLUMN IF EXISTS "paid_status",
        DROP COLUMN IF EXISTS "prepaid",
        DROP COLUMN IF EXISTS "sales_order_id",
        DROP COLUMN IF EXISTS "invoice_id",
        DROP COLUMN IF EXISTS "git_journal_entry_id",
        DROP COLUMN IF EXISTS "stock_committed_at",
        DROP COLUMN IF EXISTS "ledger_status"
    `);
    await queryRunner.query(`
      ALTER TABLE "delivery_items"
        DROP COLUMN IF EXISTS "unit_cost",
        DROP COLUMN IF EXISTS "tax_rate"
    `);
  }
}
