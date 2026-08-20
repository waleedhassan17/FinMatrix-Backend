import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Settle the ledger status on deliveries whose rejection reversal posted but
 * whose status write was lost.
 *
 * `InventoryApprovalsService.reject()` loaded the delivery, called
 * `releaseOnReject` (which loads its OWN copy, sets ledgerStatus='returned'
 * and saves), then saved the stale first copy back — reverting the field to
 * 'in_transit'. The ledger itself was always right: every affected delivery
 * has a Goods in Transit residue of exactly 0.
 *
 * So this corrects a status column only; it posts nothing. Restricted to
 * deliveries that are terminal, had stock committed, and whose Goods in
 * Transit residue is genuinely zero — a delivery still carrying value is left
 * alone for I15/I17 to keep flagging rather than being papered over.
 */
export class BackfillDeliveryLedgerStatus1787210000000 implements MigrationInterface {
  name = 'BackfillDeliveryLedgerStatus1787210000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE deliveries d
         SET ledger_status = 'returned',
             updated_at    = now()
       WHERE d.status IN ('returned', 'cancelled', 'failed')
         AND d.stock_committed_at IS NOT NULL
         AND d.ledger_status = 'in_transit'
         AND COALESCE((
               SELECT SUM(g.debit - g.credit)
                 FROM general_ledger g
                 JOIN accounts a ON a.id = g.account_id
                WHERE g.source_id  = d.id
                  AND g.company_id = d.company_id
                  AND a.account_number = '1250'
             ), 0) = 0
    `);
  }

  public async down(): Promise<void> {
    // Deliberately empty: the previous value contradicted the ledger.
  }
}
