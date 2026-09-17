import { BadRequestException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { MONEY_TOLERANCE, toDecimal } from '../../common/utils/money.util';
import { grossValue } from '../../common/utils/credit-control.util';

/**
 * Who has paid for a delivery, and how much the rider is to collect.
 *
 * A delivery's sale can be settled three ways, in any mix:
 *   - an ADVANCE taken before dispatch (a receipt held in 2400 Customer
 *     Advances, applied to the invoice at approval);
 *   - CASH the rider takes at the door (a receipt applied at approval);
 *   - the rest stays on the invoice in Accounts Receivable.
 *
 * Every route that accepts the rider's answer — the bill photo, the JSON
 * confirm, the status update — and the owner's approval run it through here,
 * so a prepaid delivery can never be recorded as unpaid, and a rider can never
 * claim more cash than was owed.
 */

export type DeliveryPaidStatus = 'paid' | 'partial' | 'unpaid';
export const DELIVERY_PAID_STATUSES: DeliveryPaidStatus[] = ['paid', 'partial', 'unpaid'];

/**
 * Cash is counted in paisa. A figure that agrees with the amount due to the
 * paisa settles it in full; anything further off is a real shortfall.
 */
export const COLLECTION_TOLERANCE = new Decimal('0.005');

export interface PricedLine {
  quantity: Decimal.Value;
  unitPrice: Decimal.Value;
  taxRate: Decimal.Value | null | undefined;
}

/** Tax-inclusive value of the lines — the same 4dp sum the invoice totals to. */
export function grossOf(lines: PricedLine[]): Decimal {
  return lines.reduce(
    (sum, l) => sum.plus(grossValue(l.quantity, l.unitPrice, l.taxRate ?? '0')),
    new Decimal(0),
  );
}

export interface Collection {
  paidStatus: DeliveryPaidStatus;
  /** Cash the rider collects, 4dp. Zero when nothing is due. */
  amountCollected: string;
  /** What the advance leaves for the door, 4dp. */
  amountDue: string;
  /** The part of the advance this sale uses, 4dp. */
  advanceApplied: string;
}

const money = (d: Decimal) => d.toFixed(4);

/**
 * What an invoice says about its sale: nothing owing is PAID, something paid
 * is PARTIAL, nothing paid is NOT PAID. Once a delivery is approved its
 * paidStatus is always this — never a separate answer that can drift.
 */
export function invoicePaidStatus(invoice: { balance: string; amountPaid: string }): DeliveryPaidStatus {
  if (!toDecimal(invoice.balance).greaterThan(MONEY_TOLERANCE)) return 'paid';
  return toDecimal(invoice.amountPaid).greaterThan(MONEY_TOLERANCE) ? 'partial' : 'unpaid';
}

function split(gross: Decimal.Value, advance: Decimal.Value) {
  const g = Decimal.max(toDecimal(gross as never), 0);
  const advanceApplied = Decimal.min(Decimal.max(toDecimal(advance as never), 0), g);
  return { advanceApplied, due: g.minus(advanceApplied) };
}

function outOfRange(message: string, due: Decimal): never {
  throw new BadRequestException({
    code: 'COLLECTED_OUT_OF_RANGE',
    message,
    details: { amountDue: money(due) },
  });
}

const fmt = (d: Decimal) => d.toFixed(2);

/**
 * Settle the collection from an AMOUNT: zero is unpaid, the full amount due is
 * paid, anything between is partial. Used for the owner's cash count at
 * approval, and for a rider's PARTIAL figure.
 */
export function collectionFromAmount(
  gross: Decimal.Value,
  advance: Decimal.Value,
  amount: Decimal.Value,
): Collection {
  const { advanceApplied, due } = split(gross, advance);
  if (!due.greaterThan(MONEY_TOLERANCE)) {
    return { paidStatus: 'paid', amountCollected: money(new Decimal(0)), amountDue: money(due), advanceApplied: money(advanceApplied) };
  }

  let collected: Decimal;
  try {
    collected = toDecimal(amount as never);
  } catch {
    outOfRange('The amount received must be a number.', due);
  }
  if (!collected.isFinite() || collected.isNegative()) {
    outOfRange('The amount received cannot be negative.', due);
  }
  if (collected.greaterThan(due.plus(COLLECTION_TOLERANCE))) {
    outOfRange(
      `The amount received (${fmt(collected)}) is more than the ${fmt(due)} due on this delivery.`,
      due,
    );
  }

  if (collected.greaterThanOrEqualTo(due.minus(COLLECTION_TOLERANCE))) {
    // Agrees with the amount due to the paisa: record exactly what was owed,
    // so the invoice closes instead of carrying a sub-paisa residue.
    return { paidStatus: 'paid', amountCollected: money(due), amountDue: money(due), advanceApplied: money(advanceApplied) };
  }
  if (!collected.greaterThan(MONEY_TOLERANCE)) {
    return { paidStatus: 'unpaid', amountCollected: money(new Decimal(0)), amountDue: money(due), advanceApplied: money(advanceApplied) };
  }
  return {
    paidStatus: 'partial',
    amountCollected: money(collected.toDecimalPlaces(4, Decimal.ROUND_HALF_UP)),
    amountDue: money(due),
    advanceApplied: money(advanceApplied),
  };
}

/**
 * Settle the collection from the rider's ANSWER.
 *
 *  - Nothing due (fully prepaid, or a short delivery the advance still covers):
 *    always 'paid' with nothing collected, whatever was sent. There is nothing
 *    to ask, so there is nothing a rider or an old app can get wrong.
 *  - 'paid'    → the whole amount due.
 *  - 'unpaid'  → nothing; it stays in A/R. Also what an older app that sends
 *                no answer gets.
 *  - 'partial' → requires the amount received, above zero and below the amount
 *                due. A figure equal to the amount due is taken as 'paid'.
 */
export function resolveCollection(input: {
  gross: Decimal.Value;
  advance: Decimal.Value;
  paidStatus?: string | null;
  amountCollected?: Decimal.Value | null;
}): Collection {
  const { advanceApplied, due } = split(input.gross, input.advance);
  const base = { amountDue: money(due), advanceApplied: money(advanceApplied) };

  if (!due.greaterThan(MONEY_TOLERANCE)) {
    return { ...base, paidStatus: 'paid', amountCollected: money(new Decimal(0)) };
  }

  const status = input.paidStatus ?? 'unpaid';
  switch (status) {
    case 'paid':
      return { ...base, paidStatus: 'paid', amountCollected: money(due) };
    case 'unpaid':
      return { ...base, paidStatus: 'unpaid', amountCollected: money(new Decimal(0)) };
    case 'partial': {
      const raw = input.amountCollected;
      if (raw === undefined || raw === null || String(raw).trim() === '') {
        outOfRange(`Enter how much the customer paid of the ${fmt(due)} due.`, due);
      }
      const settled = collectionFromAmount(input.gross, input.advance, raw);
      if (settled.paidStatus === 'unpaid') {
        outOfRange('A partial payment must be more than zero. Choose NOT PAID if the customer paid nothing.', due);
      }
      return settled;
    }
    default:
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: `Unknown payment status '${String(status)}'. Use paid, partial or unpaid.`,
      });
  }
}

// ─── Delivery-shaped inputs ───────────────────────────────────────────────

export interface DeliveryLineLike {
  itemId: string;
  orderedQty: string | number;
  quantity: string | number;
  unitPrice: string | number;
  taxRate: string | number | null;
}

/**
 * Units that left on the van. orderedQty is canonical; rows written before the
 * DTO fix carried the amount in `quantity` (see DeliveryLedgerService.lineQty).
 */
export function dispatchedQty(line: Pick<DeliveryLineLike, 'orderedQty' | 'quantity'>): Decimal {
  const ordered = toDecimal(line.orderedQty as never);
  return ordered.greaterThan(0) ? ordered : toDecimal(line.quantity as never);
}

/**
 * Tax-inclusive value of what the customer kept. A line missing from
 * `deliveredByItem` counts as fully delivered; a figure outside 0..dispatched
 * is clamped, exactly as approval clamps it.
 */
export function deliveredGross(
  lines: DeliveryLineLike[],
  deliveredByItem?: Map<string, Decimal.Value>,
): Decimal {
  return grossOf(
    lines.map((l) => {
      const dispatched = dispatchedQty(l);
      const asked = deliveredByItem?.has(l.itemId)
        ? toDecimal(deliveredByItem.get(l.itemId) as never)
        : dispatched;
      const quantity = Decimal.min(Decimal.max(asked, 0), dispatched);
      return { quantity, unitPrice: l.unitPrice, taxRate: l.taxRate };
    }),
  );
}

/**
 * The advance a delivery carries into approval. A legacy prepaid delivery has
 * no receipt and no recorded amount, but its bare advance was the whole order,
 * so it covers any sale the delivery can make.
 */
export function deliveryAdvance(
  delivery: { prepaid: boolean; advancePaymentId: string | null; advanceAmount: string | null },
  gross: Decimal.Value,
): Decimal {
  if (delivery.prepaid && !delivery.advancePaymentId) return toDecimal(gross as never);
  return toDecimal(delivery.advanceAmount ?? '0');
}

/**
 * Whether a delivery still takes a payment answer. Once approval has run (or
 * the delivery was cancelled/returned) the answer is history: approval posted
 * from it and the invoice now decides.
 */
export function acceptsCollectionAnswer(delivery: { ledgerStatus: string }): boolean {
  return delivery.ledgerStatus === 'none' || delivery.ledgerStatus === 'in_transit';
}
