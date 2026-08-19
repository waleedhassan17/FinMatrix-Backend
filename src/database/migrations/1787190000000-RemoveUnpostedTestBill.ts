import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Remove BILL-2026-0005 and return the vendor credit it consumed.
 *
 * The bill was a draft that a vendor credit was applied to before the
 * BILL_NOT_POSTED guard existed. Applying the credit flipped it to `paid`
 * without a journal entry ever being written, so it sat in the books as a
 * settled purchase that account 2000 had never heard of — invariant I7
 * (`journal_entry_id IS NULL AND status <> 'draft'`).
 *
 * Nothing was ever posted for it: no general_ledger row references the bill and
 * it has no bill_payment_applications, so removing it moves no money. Its one
 * line reads "kjjhihiuhiuh" for 777.00 + 77.70 tax — a test artifact, not a
 * purchase. Deleting matches what BillsService.delete() does for a bill with no
 * journal entry; voiding would not clear I7, which exempts only drafts.
 *
 * The Rs 854.70 it consumed came from VC-2026-0002 (Rs 10,000, applied 854.70,
 * balance 9,145.30). `applyToBill` records no application row — it only mutates
 * the credit and the bill — so the reversal is done by restoring the credit's
 * own columns. The amount is unique across all vendor credits, so there is no
 * ambiguity about which application is being undone.
 *
 * Every statement is guarded on the exact state being corrected, so a re-run,
 * or a run against a database that never had this row, is a no-op.
 */
export class RemoveUnpostedTestBill1787190000000 implements MigrationInterface {
  name = 'RemoveUnpostedTestBill1787190000000';

  private readonly BILL_ID = 'b1613d97-4e24-4662-88d4-52a373b00a4d';
  private readonly CREDIT_ID = '2345d457-340e-4c46-9bd1-a813aa7a19a8';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1) Return the 854.70 to unapplied. `status` goes back to 'open' because
    //    the credit still has its full balance and nothing is applied to it.
    await queryRunner.query(
      `
      UPDATE vendor_credits
         SET amount_applied = '0.0000',
             balance        = total,
             status         = 'open',
             updated_at     = now()
       WHERE id = $1
         AND amount_applied = '854.7000'
      `,
      [this.CREDIT_ID],
    );

    // 2) Remove the bill, but only while it is still the unposted row this
    //    migration was written for. If anything ever posted it, leave it alone.
    await queryRunner.query(
      `
      DELETE FROM bill_line_items
       WHERE bill_id = $1
         AND EXISTS (
           SELECT 1 FROM bills
            WHERE id = $1 AND journal_entry_id IS NULL AND status = 'paid'
         )
      `,
      [this.BILL_ID],
    );
    await queryRunner.query(
      `
      DELETE FROM bills
       WHERE id = $1
         AND journal_entry_id IS NULL
         AND status = 'paid'
      `,
      [this.BILL_ID],
    );
  }

  public async down(): Promise<void> {
    // Deliberately empty. The removed row was an unposted test artifact that
    // violated I7; recreating it would reintroduce the violation.
  }
}
