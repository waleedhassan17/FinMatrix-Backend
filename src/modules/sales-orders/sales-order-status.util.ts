import Decimal from 'decimal.js';
import { toDecimal } from '../../common/utils/money.util';

/**
 * Pure rules for a sales order's shipping and invoicing progress.
 *
 * Per line: q = ordered (`quantity`), s = shipped (`quantityFulfilled`),
 * i = invoiced (`quantityInvoiced`). Stock and COGS move when an invoice
 * posts, so i is also what has left the books.
 *
 * New data keeps 0 ≤ i ≤ s ≤ q. Orders invoiced in full before partial
 * invoicing existed may have i = q > s: billed, delivery still pending.
 */

export type DerivedSalesOrderStatus =
  | 'open'
  | 'partial'
  | 'fulfilled'
  | 'invoiced';

export type SoDiscountType = 'percent' | 'amount' | 'none';

export interface SoLineQty {
  id: string;
  quantity: string;
  quantityFulfilled: string;
  quantityInvoiced: string;
}

export interface SoLinePriced extends SoLineQty {
  unitPrice: string;
  taxRate: string;
}

const ZERO = new Decimal(0);
const q = (l: SoLineQty) => toDecimal(l.quantity);
const s = (l: SoLineQty) => toDecimal(l.quantityFulfilled);
const i = (l: SoLineQty) => toDecimal(l.quantityInvoiced);

/** Status from the lines alone. 'closed' and 'cancelled' are set by hand. */
export function deriveSalesOrderStatus(
  lines: SoLineQty[],
): DerivedSalesOrderStatus {
  const live = lines.filter((l) => q(l).greaterThan(0));
  const any = lines.some((l) => s(l).greaterThan(0) || i(l).greaterThan(0));
  if (!any || live.length === 0) return any ? 'partial' : 'open';
  if (live.every((l) => i(l).greaterThanOrEqualTo(q(l)))) return 'invoiced';
  if (live.every((l) => s(l).greaterThanOrEqualTo(q(l)))) return 'fulfilled';
  return 'partial';
}

/** Shipped but not yet billed. */
export function invoiceableQty(l: SoLineQty): Decimal {
  return Decimal.max(s(l).minus(i(l)), 0);
}

/** Not yet delivered (including goods billed ahead of delivery). */
export function toShipQty(l: SoLineQty): Decimal {
  return Decimal.max(q(l).minus(s(l)), 0);
}

/** Billed ahead of delivery: only orders converted before partial invoicing. */
export function billedNotShippedQty(l: SoLineQty): Decimal {
  return Decimal.max(i(l).minus(s(l)), 0);
}

export function isUntouched(lines: SoLineQty[]): boolean {
  return lines.every((l) => s(l).isZero() && i(l).isZero());
}

export function hasShippedUninvoiced(lines: SoLineQty[]): boolean {
  return lines.some((l) => s(l).greaterThan(i(l)));
}

export function hasAnyInvoiced(lines: SoLineQty[]): boolean {
  return lines.some((l) => i(l).greaterThan(0));
}

export function hasAnyShipped(lines: SoLineQty[]): boolean {
  return lines.some((l) => s(l).greaterThan(0));
}

export type ShipmentChange =
  | { ok: true; next: Decimal; checkDelta: Decimal }
  | {
      ok: false;
      code: 'VALIDATION_FAILED' | 'OVER_FULFILLED' | 'SHIPPED_BELOW_INVOICED';
      message: string;
    };

/**
 * Validate a new running shipped total for a line.
 *
 * Lowering is allowed down to what has been invoiced, never below it (the
 * invoice already took those goods off the books). `checkDelta` is the part of
 * the increase that is new to the books — above both the old shipped total
 * and the invoiced quantity — and is the only part that needs a stock and
 * credit check: goods already invoiced left the shelf and are already owed.
 */
export function shipmentChange(
  l: SoLineQty,
  nextValue: Decimal.Value,
): ShipmentChange {
  const next = new Decimal(nextValue);
  if (next.isNaN() || next.lessThan(0)) {
    return {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Shipped quantity cannot be negative',
    };
  }
  if (next.greaterThan(q(l))) {
    return {
      ok: false,
      code: 'OVER_FULFILLED',
      message: 'Fulfilled quantity exceeds ordered quantity',
    };
  }
  if (next.lessThan(s(l)) && next.lessThan(i(l))) {
    return {
      ok: false,
      code: 'SHIPPED_BELOW_INVOICED',
      message: `${i(l).toFixed(0)} of this line ${i(l).equals(1) ? 'is' : 'are'} already invoiced, so the shipped quantity cannot go below that. Void the invoice first to reverse the shipment.`,
    };
  }
  const checkDelta = Decimal.max(next.minus(Decimal.max(s(l), i(l))), 0);
  return { ok: true, next, checkDelta };
}

// ── invoicing plan ─────────────────────────────────────────────────────────

export type InvoiceMode = 'ship_and_invoice' | 'shipped';

export interface PlanOrder {
  discountType: SoDiscountType;
  discountValue: string;
  discountAmount: string;
}

export interface InvoicePlanLine {
  lineId: string;
  quantity: Decimal;
}

export interface InvoicePlan {
  mode: InvoiceMode;
  /** Lines to bill, in order line order, quantity > 0 only. */
  lines: InvoicePlanLine[];
  /** After this invoice every line is billed in full. */
  isFinal: boolean;
  discount: { type: SoDiscountType; value: string };
}

/**
 * What an invoice raised now would bill, by default:
 * - an order with nothing shipped or invoiced is shipped and invoiced in one
 *   step, in full (the shortcut users relied on before partial invoicing);
 * - otherwise exactly what has shipped and is not yet billed.
 * Null when there is nothing to bill.
 */
export function defaultInvoiceQuantities(
  lines: SoLineQty[],
): { mode: InvoiceMode; quantities: Map<string, Decimal> } | null {
  const quantities = new Map<string, Decimal>();
  if (isUntouched(lines)) {
    for (const l of lines) {
      if (q(l).greaterThan(0)) quantities.set(l.id, q(l));
    }
    return quantities.size ? { mode: 'ship_and_invoice', quantities } : null;
  }
  for (const l of lines) {
    const qty = invoiceableQty(l);
    if (qty.greaterThan(0)) quantities.set(l.id, qty);
  }
  return quantities.size ? { mode: 'shipped', quantities } : null;
}

const round2 = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);

/**
 * The discount an invoice of this order carries.
 *
 * Percent discounts apply as they are. A fixed amount is shared out by value:
 * each invoice takes order discount × its subtotal / the order's subtotal,
 * capped at what is still unused, and the invoice that completes the order
 * takes the exact remainder, so the invoices add up to the order's discount.
 * A one-step (whole order) invoice keeps the order's own discount unchanged.
 * Closing an order early forfeits the unused part of a fixed discount.
 */
export function invoiceDiscount(
  order: PlanOrder,
  lines: SoLinePriced[],
  quantities: Map<string, Decimal>,
  ctx: { mode: InvoiceMode; isFinal: boolean; usedDiscount: Decimal.Value },
): { type: SoDiscountType; value: string } {
  if (order.discountType === 'percent') {
    return {
      type: 'percent',
      value: toDecimal(order.discountValue).toFixed(4),
    };
  }
  if (order.discountType !== 'amount') return { type: 'none', value: '0' };
  if (ctx.mode === 'ship_and_invoice') {
    return { type: 'amount', value: toDecimal(order.discountValue).toFixed(4) };
  }
  const orderDiscount = toDecimal(order.discountAmount);
  const remaining = Decimal.max(
    orderDiscount.minus(new Decimal(ctx.usedDiscount)),
    0,
  );
  if (ctx.isFinal) return { type: 'amount', value: remaining.toFixed(4) };
  let orderSubtotal = ZERO;
  let invSubtotal = ZERO;
  for (const l of lines) {
    const price = toDecimal(l.unitPrice);
    orderSubtotal = orderSubtotal.plus(q(l).times(price));
    const qty = quantities.get(l.id);
    if (qty) invSubtotal = invSubtotal.plus(qty.times(price));
  }
  if (!orderSubtotal.greaterThan(0)) return { type: 'amount', value: '0.0000' };
  const share = Decimal.min(
    round2(orderDiscount.times(invSubtotal).dividedBy(orderSubtotal)),
    remaining,
  );
  return { type: 'amount', value: share.toFixed(4) };
}

/** Assemble the plan for given quantities. */
export function buildInvoicePlan(
  order: PlanOrder,
  lines: SoLinePriced[],
  mode: InvoiceMode,
  quantities: Map<string, Decimal>,
  usedDiscount: Decimal.Value,
): InvoicePlan {
  const planLines: InvoicePlanLine[] = [];
  let isFinal = true;
  for (const l of lines) {
    const qty = quantities.get(l.id) ?? ZERO;
    if (qty.greaterThan(0)) planLines.push({ lineId: l.id, quantity: qty });
    if (q(l).greaterThan(0) && i(l).plus(qty).lessThan(q(l))) isFinal = false;
  }
  const discount = invoiceDiscount(order, lines, quantities, {
    mode,
    isFinal,
    usedDiscount,
  });
  return { mode, lines: planLines, isFinal, discount };
}

export function planSalesOrderInvoice(
  order: PlanOrder,
  lines: SoLinePriced[],
  usedDiscount: Decimal.Value,
): InvoicePlan | null {
  const d = defaultInvoiceQuantities(lines);
  if (!d) return null;
  return buildInvoicePlan(order, lines, d.mode, d.quantities, usedDiscount);
}

// ── staff requests approved later ──────────────────────────────────────────

export interface ApprovedConversion {
  mode?: InvoiceMode;
  lines?: Array<{
    salesOrderLineId?: string;
    quantity?: string;
    unitPrice?: string;
    taxRate?: string;
  }>;
  discountType?: SoDiscountType;
  discountValue?: string;
}

/**
 * A staff member's conversion is reviewed by the owner and approved later.
 * Bill exactly what the owner saw — but only if the order still allows it.
 * Anything that changed since (a shipment, an invoice, a price) refuses, so
 * the request is filed again against the order as it is now.
 */
export function validateApprovedConversion(
  order: PlanOrder,
  lines: SoLinePriced[],
  usedDiscount: Decimal.Value,
  approved: ApprovedConversion,
): { ok: true; plan: InvoicePlan } | { ok: false; reason: string } {
  const current = defaultInvoiceQuantities(lines);
  const reqLines = approved.lines ?? [];
  const hasIds =
    reqLines.length > 0 && reqLines.every((l) => !!l.salesOrderLineId);
  if (!hasIds) {
    // Filed before requests carried line ids: it billed the whole order, which
    // is still right only while nothing has shipped or been invoiced.
    if (current?.mode !== 'ship_and_invoice') {
      return { ok: false, reason: 'shipments or invoices were recorded since' };
    }
    return {
      ok: true,
      plan: buildInvoicePlan(
        order,
        lines,
        current.mode,
        current.quantities,
        usedDiscount,
      ),
    };
  }
  if (!current)
    return { ok: false, reason: 'there is nothing left to invoice' };
  const mode = approved.mode ?? 'shipped';
  if (mode !== current.mode) {
    return { ok: false, reason: 'shipments or invoices were recorded since' };
  }
  const byId = new Map(lines.map((l) => [l.id, l]));
  const quantities = new Map<string, Decimal>();
  for (const r of reqLines) {
    const line = byId.get(r.salesOrderLineId!);
    if (!line) return { ok: false, reason: 'its lines were changed' };
    if (
      r.unitPrice !== undefined &&
      !toDecimal(r.unitPrice).equals(toDecimal(line.unitPrice))
    ) {
      return { ok: false, reason: 'a price was changed' };
    }
    if (
      r.taxRate !== undefined &&
      !toDecimal(r.taxRate).equals(toDecimal(line.taxRate))
    ) {
      return { ok: false, reason: 'a tax rate was changed' };
    }
    const qty = toDecimal(r.quantity ?? 0);
    const allowed =
      mode === 'ship_and_invoice' ? q(line) : invoiceableQty(line);
    if (!qty.greaterThan(0) || qty.greaterThan(allowed)) {
      return { ok: false, reason: 'the shipped quantities changed' };
    }
    if (mode === 'ship_and_invoice' && !qty.equals(q(line))) {
      return { ok: false, reason: 'the shipped quantities changed' };
    }
    quantities.set(line.id, (quantities.get(line.id) ?? ZERO).plus(qty));
  }
  const plan = buildInvoicePlan(order, lines, mode, quantities, usedDiscount);
  if (approved.discountType !== undefined) {
    const sameType = approved.discountType === plan.discount.type;
    const sameValue = toDecimal(approved.discountValue ?? 0).equals(
      toDecimal(plan.discount.value),
    );
    if (!sameType || !sameValue) {
      return { ok: false, reason: 'its discount changed' };
    }
  }
  return { ok: true, plan };
}

// ── voiding / deleting an invoice ──────────────────────────────────────────

/**
 * Give an invoice's quantities back to its order. A one-step invoice also
 * recorded the shipment, so it un-ships the same quantity. A closed order
 * reverts to its derived status only if shipped goods are left unbilled (they
 * must be invoiced again or the shipment reversed); cancelled stays cancelled.
 */
export function applyRelease(
  lines: SoLineQty[],
  released: Map<string, Decimal>,
  opts: { autoShipped: boolean; status: string },
): { lines: SoLineQty[]; status: string } {
  const next = lines.map((l) => {
    const r = released.get(l.id);
    if (!r) return { ...l };
    return {
      ...l,
      quantityInvoiced: Decimal.max(i(l).minus(r), 0).toFixed(4),
      quantityFulfilled: opts.autoShipped
        ? Decimal.max(s(l).minus(r), 0).toFixed(4)
        : l.quantityFulfilled,
    };
  });
  let status = opts.status;
  if (status === 'cancelled') return { lines: next, status };
  if (status !== 'closed' || hasShippedUninvoiced(next)) {
    status = deriveSalesOrderStatus(next);
  }
  return { lines: next, status };
}
