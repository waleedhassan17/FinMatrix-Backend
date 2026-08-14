import { UnprocessableEntityException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { toDecimal, MoneyInput } from './money.util';

/**
 * Negative-stock guard (invariant I11).
 *
 * G1 added `chk_no_negative_stock` on inventory_items, so a path that drives
 * quantity_on_hand below zero now fails at the database. That is the correct
 * backstop, but on its own it surfaces to the user as an opaque 500. Every
 * service that decrements stock calls this first so the user gets a clean 422
 * naming the item and the shortfall instead.
 *
 * Mirrors the inline guards that delivery-ledger and inventory-approvals
 * already had; those keep their own context-specific messages.
 */
export function assertSufficientStock(
  itemName: string,
  onHand: MoneyInput,
  requested: MoneyInput,
): void {
  const have = toDecimal(onHand);
  const want = toDecimal(requested);
  if (have.lessThan(want)) {
    throw new UnprocessableEntityException({
      code: 'INSUFFICIENT_STOCK',
      message: `Cannot move ${want.toFixed(0)} x ${itemName}: only ${have.toFixed(0)} on hand.`,
    });
  }
}

/**
 * Guard for paths that set an absolute quantity (adjustments, physical counts)
 * rather than applying a delta.
 */
export function assertNonNegativeQuantity(
  itemName: string,
  quantity: MoneyInput,
): void {
  const qty = toDecimal(quantity);
  if (qty.lessThan(new Decimal(0))) {
    throw new UnprocessableEntityException({
      code: 'INSUFFICIENT_STOCK',
      message: `Quantity on hand for ${itemName} cannot be negative (got ${qty.toFixed(4)}).`,
    });
  }
}
