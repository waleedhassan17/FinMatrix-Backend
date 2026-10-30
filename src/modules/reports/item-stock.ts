/**
 * One item's stock position, as the item explorer states it.
 *
 * Every rule here is the Health tab's own, applied to one item — whether it
 * is below its reorder point, what to order, whether it is dead stock — so an
 * item never reads "Low stock" on its page and is missing from the reorder
 * list, or the other way round.
 *
 * Days of cover used to be worked out by the web and the app separately. It
 * is worked out here now, so the verdict beside it (kpi-benchmarks.ts) is
 * judged on the same number both clients print; the arithmetic is unchanged,
 * and the spec holds it to the clients' own fixtures.
 *
 * Free of I/O, Nest and TypeORM, and every date is a parameter, so the rules
 * are tested directly and never depend on the day the tests run.
 */
import { daysBetweenIso } from '../../common/utils/business-date.util';
import { DEAD_STOCK_DAYS } from './inventory-movement-rules';

const EPS = 0.00005;
const r2 = (n: number) => Math.round(n * 100) / 100;

export type ItemStockStatus = 'ok' | 'low' | 'out';

/**
 * Out with nothing on hand; low at or below a reorder point that has been
 * set. An item with no reorder point is never "low", only in or out of stock.
 */
export function itemStockStatus(
  qtyOnHand: number,
  reorderPoint: number,
): ItemStockStatus {
  if (qtyOnHand <= EPS) return 'out';
  if (reorderPoint > 0 && qtyOnHand <= reorderPoint) return 'low';
  return 'ok';
}

/**
 * What the reorder list suggests ordering: the item's reorder quantity, or
 * the shortfall below its reorder point if that is more. Null when no reorder
 * is due — above the point, or no point set.
 */
export function suggestedOrderQty(
  qtyOnHand: number,
  reorderPoint: number,
  reorderQuantity: number,
): number | null {
  if (!(reorderPoint > 0) || qtyOnHand > reorderPoint) return null;
  return r2(Math.max(reorderQuantity, reorderPoint - qtyOnHand));
}

/**
 * Days the stock on hand lasts at the window's selling rate.
 *
 * The rate is units sold per ELAPSED day: a window that runs to the end of
 * this month has not had those days yet, and counting them would understate
 * the rate and overstate the cover. Null when nothing sold (no rate to divide
 * by); zero when it is out of stock and still selling — the one case where
 * "out of stock" is a sale being lost, rather than an item nobody asks for.
 */
export function daysOfCover(
  qtyOnHand: number,
  unitsSold: number,
  startDate: string,
  endDate: string,
  today: string,
): number | null {
  if (qtyOnHand <= 0) return unitsSold > 0 ? 0 : null;
  const until = endDate > today ? today : endDate;
  const days = daysBetweenIso(startDate, until) + 1;
  if (days <= 0 || unitsSold <= 0) return null;
  return Math.round(qtyOnHand / (unitsSold / days));
}

/**
 * Stock on hand with nothing out — no sale, no delivery — in more than
 * DEAD_STOCK_DAYS, or ever. The Health tab's dead-stock list, for one item.
 */
export function isDeadStock(
  qtyOnHand: number,
  lastOutboundDate: string | null,
  today: string,
): boolean {
  if (qtyOnHand <= EPS) return false;
  if (!lastOutboundDate) return true;
  return daysBetweenIso(lastOutboundDate, today) > DEAD_STOCK_DAYS;
}
