import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Record which credit memo reversed a delivery.
 *
 * Reversing an approved delivery is now one tap, which removed the accidental
 * protection the old LEDGER_COMMITTED error used to provide: nothing links a
 * credit memo back to the delivery it reverses, and the button stays on the
 * approved row afterwards. Tapping it twice debits Sales twice for one sale,
 * and every entry balances, so no invariant would notice.
 *
 * This column is what makes a second reversal refusable. It also gives the
 * delivery → credit-memo audit link that nothing recorded before: until now
 * the only trace was free text in the memo's `reason`.
 *
 * Nullable, and existing rows stay null — a delivery reversed before this
 * shipped has no id to record, and inventing one would be worse than leaving
 * the gap visible.
 *
 * No foreign key to credit_memos: the codebase scopes by id without one
 * throughout, and a memo that is later voided should still show as the thing
 * that reversed this delivery.
 */
export class DeliveryReversalLink1787270000000 implements MigrationInterface {
  name = 'DeliveryReversalLink1787270000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_update_requests"
        ADD COLUMN IF NOT EXISTS "reversal_credit_memo_id" uuid
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "inventory_update_requests"
        DROP COLUMN IF EXISTS "reversal_credit_memo_id"
    `);
  }
}
