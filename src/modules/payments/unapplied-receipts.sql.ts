/**
 * The SQL for "money a customer has paid that no invoice has used yet".
 *
 * It lives apart from PaymentsService because two features read it: the
 * receive-payment flow, which offers these receipts before a new one is
 * recorded, and the customer's outstanding-invoices summary, which nets them
 * off what is owed. Written once, the two cannot disagree about which receipts
 * are free.
 */

/**
 * A delivery that still owns the advance receipt `paymentIdExpr`: taken before
 * dispatch and not yet approved, cancelled or returned. Approval applies that
 * advance to the delivery's own invoice, so until then it may be neither spent
 * on another invoice nor deleted.
 */
export const OPEN_DELIVERY_ADVANCE_SQL = (paymentIdExpr: string) => `
  SELECT d.id, d.reference_no FROM deliveries d
   WHERE d.advance_payment_id = ${paymentIdExpr}
     AND d.ledger_status IN ('none', 'in_transit')
     AND d.status NOT IN ('cancelled', 'failed', 'returned')`;

/**
 * One customer's receipts still holding unapplied money, oldest first.
 *
 * Parameters: `$1` company id, `$2` customer id, `$3` the money tolerance — a
 * remainder at or under it is rounding, not money.
 */
export const UNAPPLIED_RECEIPTS_SQL = `
  SELECT p.id, p.payment_number, p.payment_date::text AS payment_date, p.amount,
         p.advance_posted,
         (p.amount - COALESCE(SUM(pa.amount_applied), 0)) AS unapplied
    FROM payments p
    LEFT JOIN payment_applications pa ON pa.payment_id = p.id
   WHERE p.company_id = $1 AND p.customer_id = $2
     -- An advance taken for a delivery still on its way belongs to that
     -- delivery: approval applies it. It is not free to spend elsewhere.
     AND NOT EXISTS (${OPEN_DELIVERY_ADVANCE_SQL('p.id')})
   GROUP BY p.id
  HAVING p.amount - COALESCE(SUM(pa.amount_applied), 0) > $3
   ORDER BY p.payment_date, p.created_at`;

/** A row of {@link UNAPPLIED_RECEIPTS_SQL}. */
export interface UnappliedReceiptRow {
  id: string;
  payment_number: string | null;
  payment_date: string;
  amount: string;
  advance_posted: boolean;
  unapplied: string;
}
