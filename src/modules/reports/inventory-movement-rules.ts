/**
 * Which inventory movements count as stock arriving and stock leaving.
 *
 * Inventory health (reports-kpi.service.ts) ages stock and finds dead stock
 * by these rules, and the item explorer (reports.service.ts) flags one item
 * as dead stock by the same ones, so the two pages can never disagree about
 * an item. They live here, free of Nest and TypeORM, because the KPI service
 * already imports ReportsService: importing them back from it would be a
 * cycle.
 *
 * The SQL fragments read an `inventory_movements` row aliased `m`.
 */
import type { InventoryMovementType } from '../../types';

/**
 * How each inventory movement type bears on stock aging.
 *
 *  receipt    inbound   goods received from a supplier (purchase-order receipt)
 *  return     inbound   goods back on the shelf: a customer return (credit
 *                       memo, delivery return) or a voided sale
 *  sale       outbound  goods invoiced out — and goods sent back to a supplier
 *                       on a vendor credit, which leave the shelf just the same
 *  delivery   outbound  goods dispatched on a delivery
 *  transfer   neutral   moved between locations; still on hand
 *  adjustment neutral   counts, shrinkage and write-offs — EXCEPT opening stock
 *                       (source_type 'opening_stock'), which is the first time
 *                       the goods arrive and is treated as inbound
 *
 * A direction only counts with the matching sign: an inbound type whose
 * quantity went DOWN is a reversal (a voided receipt), not an arrival.
 */
export const INVENTORY_MOVEMENT_DIRECTION: Record<
  InventoryMovementType,
  'inbound' | 'outbound' | 'neutral'
> = {
  receipt: 'inbound',
  return: 'inbound',
  sale: 'outbound',
  delivery: 'outbound',
  transfer: 'neutral',
  adjustment: 'neutral',
};
export const INBOUND_ADJUSTMENT_SOURCES = ['opening_stock'];

const typesBy = (d: 'inbound' | 'outbound') =>
  Object.entries(INVENTORY_MOVEMENT_DIRECTION)
    .filter(([, v]) => v === d)
    .map(([k]) => `'${k}'`)
    .join(', ');
export const INBOUND_SQL = `(m.quantity_change::numeric > 0 AND (m.type IN (${typesBy('inbound')})
  OR (m.type = 'adjustment' AND m.source_type IN (${INBOUND_ADJUSTMENT_SOURCES.map((x) => `'${x}'`).join(', ')}))))`;
export const OUTBOUND_SQL = `(m.quantity_change::numeric < 0 AND m.type IN (${typesBy('outbound')}))`;

export const AGE_BUCKETS = [
  { key: 'd0_30', label: '0–30 days', max: 30 },
  { key: 'd31_90', label: '31–90 days', max: 90 },
  { key: 'd91_180', label: '91–180 days', max: 180 },
  { key: 'd180_plus', label: 'More than 180 days', max: Infinity },
] as const;

/**
 * Stock with nothing out (no sale, no delivery) in more than this many days
 * is dead stock — on the Health tab and on the item's own page alike.
 */
export const DEAD_STOCK_DAYS = 180;
