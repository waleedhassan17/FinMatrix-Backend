import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Correct the stored closing shelf figure on delivery approval lines.
 *
 * When a delivery's stock is committed to Goods in Transit at assignment, the
 * dispatched units have already left warehouse on-hand. Both writers of
 * `after_qty` subtracted the delivered units from that figure a second time,
 * so a delivery of 10 against 15 on hand recorded a closing figure of 5 while
 * the item really held 15. `after_qty` is what every later stock report reads,
 * so the wrong number outlives the request.
 *
 * Correct values, for GIT deliveries only:
 *   approved  → before + returned   (delivered units are sold out of transit,
 *                                    only what came back rejoins the shelf)
 *   otherwise → before              (nothing was applied, so nothing moved)
 *
 * Legacy pre-GIT deliveries (`stock_committed_at IS NULL`) never moved stock at
 * assignment, so `before - delivered + returned` was always right for them and
 * they are deliberately untouched.
 *
 * This corrects a reporting column only — it posts nothing and moves no money,
 * so the ledger and the inventory subledger are unaffected. Idempotent: the
 * WHERE clause matches nothing on a second run.
 */
export class BackfillDeliveryAfterQty1787180000000 implements MigrationInterface {
  name = 'BackfillDeliveryAfterQty1787180000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE inventory_update_request_lines l
      SET after_qty = CASE
            WHEN r.status = 'approved' THEN l.before_qty + l.returned_qty
            ELSE l.before_qty
          END
      FROM inventory_update_requests r
      JOIN deliveries d ON d.id = r.delivery_id
      WHERE r.id = l.request_id
        AND d.stock_committed_at IS NOT NULL
        AND l.after_qty <> CASE
              WHEN r.status = 'approved' THEN l.before_qty + l.returned_qty
              ELSE l.before_qty
            END
    `);
  }

  public async down(): Promise<void> {
    // Deliberately empty. The previous values were arithmetically wrong; there
    // is nothing to restore them to that would be more correct.
  }
}
