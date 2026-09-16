import { BadRequestException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { companyFeatures } from '../features/company-features.util';
import { toDecimal } from './money.util';

/**
 * What a line on an estimate, sales order or invoice sells.
 *
 * 'item'    — an inventory item; selling it relieves stock and posts COGS.
 * 'service' — a service or charge (delivery, installation, labour) with no
 *             stock behind it.
 *
 * Not stored: a saved line without an item IS a service line, so documents
 * written before this rule still convert and post exactly as they did.
 */
export const SALES_LINE_KINDS = ['item', 'service'] as const;
export type SalesLineKind = (typeof SALES_LINE_KINDS)[number];

export interface ClassifiableLine {
  description?: string;
  itemId?: string | null;
  lineKind?: SalesLineKind;
}

export const lineKindOf = (itemId: string | null | undefined): SalesLineKind =>
  itemId ? 'item' : 'service';

/**
 * In a company that tracks inventory, a product has to be one of its stock
 * items. A sales order for "Roar-X Drinks" — typed in, not in stock, not in the
 * catalogue — used to save, and invoicing it posted revenue with no cost and
 * moved no stock. A typed line is still allowed, but only when it is declared a
 * service/charge, so it is a deliberate choice rather than a slip.
 *
 * Companies without inventory keep free-text lines: they have no items to pick.
 */
export async function assertSalesLinesClassified(
  manager: EntityManager,
  companyId: string,
  lines: ClassifiableLine[],
  opts: { treatFreeTextAsService?: boolean } = {},
): Promise<void> {
  const features = await companyFeatures(manager, companyId);
  if (!features.inventory) return;
  lines.forEach((l, i) => {
    const label = `Line ${i + 1}${l.description ? ` (${l.description})` : ''}`;
    if (l.itemId && l.lineKind === 'service') {
      throw new BadRequestException({
        code: 'LINE_KIND_MISMATCH',
        message: `${label} is marked as a service but is linked to an inventory item.`,
      });
    }
    if (!l.itemId && l.lineKind !== 'service' && !opts.treatFreeTextAsService) {
      throw new BadRequestException({
        code: 'LINE_ITEM_REQUIRED',
        message: `${label}: pick an inventory item, or mark the line as a service / charge.`,
        details: { lineIndex: i },
      });
    }
  });
}

/** Stock position of one item, as far as sales are concerned. */
export interface StockPosition {
  itemId: string;
  name: string;
  sku: string;
  onHand: string;
  /** Promised on other open sales orders (not yet invoiced or delivered). */
  committed: string;
  /** on hand − committed. May be negative when already over-promised. */
  available: string;
}

/**
 * On-hand, committed and available quantity for a set of items.
 *
 * Committed is the quantity on sales orders that are still open, partially or
 * fully fulfilled but not yet invoiced — stock that is promised but has not
 * left the books. Orders created by a delivery are excluded: a dispatch moves
 * the stock off the shelf itself.
 */
export async function stockPositions(
  manager: EntityManager,
  companyId: string,
  itemIds: string[],
  opts: { excludeSalesOrderId?: string | null } = {},
): Promise<Map<string, StockPosition>> {
  const ids = [...new Set(itemIds.filter(Boolean))];
  const positions = new Map<string, StockPosition>();
  if (ids.length === 0) return positions;

  const items: Array<{ id: string; name: string; sku: string; quantity_on_hand: string }> = await manager.query(
    `SELECT id, name, sku, quantity_on_hand FROM inventory_items WHERE company_id = $1 AND id = ANY($2::uuid[])`,
    [companyId, ids],
  );
  const committedRows: Array<{ item_id: string; committed: string }> = await manager.query(
    `SELECT l.item_id, SUM(l.quantity) AS committed
       FROM sales_order_line_items l
       JOIN sales_orders o ON o.id = l.sales_order_id
      WHERE o.company_id = $1
        AND o.status IN ('open', 'partial', 'fulfilled')
        AND l.item_id = ANY($2::uuid[])
        AND ($3::uuid IS NULL OR o.id <> $3::uuid)
        AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.sales_order_id = o.id)
      GROUP BY l.item_id`,
    [companyId, ids, opts.excludeSalesOrderId ?? null],
  );
  const committed = new Map(committedRows.map((r) => [r.item_id, toDecimal(r.committed)]));
  for (const item of items) {
    const onHand = toDecimal(item.quantity_on_hand);
    const promised = committed.get(item.id) ?? new Decimal(0);
    positions.set(item.id, {
      itemId: item.id,
      name: item.name,
      sku: item.sku,
      onHand: onHand.toFixed(4),
      committed: promised.toFixed(4),
      available: onHand.minus(promised).toFixed(4),
    });
  }
  return positions;
}

export interface BackorderLine {
  itemId: string;
  name: string;
  sku: string;
  requested: string;
  available: string;
  shortfall: string;
}

/** Lines asking for more than is available, with the shortfall per item. */
export async function backorderLines(
  manager: EntityManager,
  companyId: string,
  lines: Array<{ itemId?: string | null; quantity: string }>,
  opts: { excludeSalesOrderId?: string | null } = {},
): Promise<BackorderLine[]> {
  // Several lines can ask for the same item; they draw on the same stock.
  const requested = new Map<string, Decimal>();
  for (const l of lines) {
    if (!l.itemId) continue;
    requested.set(l.itemId, (requested.get(l.itemId) ?? new Decimal(0)).plus(toDecimal(l.quantity)));
  }
  const positions = await stockPositions(manager, companyId, [...requested.keys()], opts);
  const out: BackorderLine[] = [];
  for (const [itemId, qty] of requested) {
    const pos = positions.get(itemId);
    if (!pos) continue;
    const available = Decimal.max(toDecimal(pos.available), 0);
    if (qty.greaterThan(available)) {
      out.push({
        itemId,
        name: pos.name,
        sku: pos.sku,
        requested: qty.toFixed(4),
        available: available.toFixed(4),
        shortfall: qty.minus(available).toFixed(4),
      });
    }
  }
  return out;
}
