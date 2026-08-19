import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Correct the average cost that the clamped re-averaging overstated.
 *
 * `PurchaseOrdersService` folded a receipt into the weighted average using
 * `oldValue = onHand < 0 ? 0 : onHand * unitCost` while still dividing by the
 * netted `onHand + delta`. With stock oversold to -18 units, receiving 28 @
 * Rs 1,800 priced the item at 50,400 / 10 = Rs 5,040 instead of the correct
 * (-32,400 + 50,400) / 10 = Rs 1,800.
 *
 * The GL was never wrong: account 1200 was debited the Rs 50,400 actually
 * purchased. Only the subledger's unit cost was inflated, which is why
 * invariant I13 read GL 219,900 against a valuation of 252,300 — a drift of
 * exactly 32,400, being the 18 oversold units at 1,800.
 *
 * So there is NO correcting journal entry here, and there must not be: posting
 * one would move a GL that is already right and create a real imbalance. The
 * fix is to restore the item's cost, after which valuation ties to the GL.
 *
 * Scoped to the one item whose cost this produced (WC-OIL-5L, still holding the
 * inflated 5,040) and guarded so a re-run, or a database that never carried the
 * defect, is a no-op.
 */
export class FixOverstatedAverageCost1787200000000 implements MigrationInterface {
  name = 'FixOverstatedAverageCost1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE inventory_items
         SET unit_cost  = '1800.0000',
             updated_at = now()
       WHERE sku = 'WC-OIL-5L'
         AND unit_cost = '5040.0000'
    `);
  }

  public async down(): Promise<void> {
    // Deliberately empty. The previous value was arithmetically wrong and is
    // what invariant I13 flags; restoring it would reintroduce the drift.
  }
}
