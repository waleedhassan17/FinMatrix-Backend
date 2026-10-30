import {
  CHART,
  ledgerQuery,
  makeKpiService,
  type PostingFixture,
} from '../../../test/reports-ledger-fixture';

/**
 * inventoryHealth() as a whole: which items it suggests reordering, what it
 * calls dead stock, how it ages stock and where the value sits — read on the
 * dated movement record (a past asOf), so every figure here is one the
 * fixture states outright.
 */
const AS_OF = '2026-06-30';

/** What the items query returns: one row per item, movements summed to asOf. */
const ITEMS = [
  // Below its reorder point and still sold: reorder it.
  {
    itemId: 'a',
    name: 'Alpha',
    sku: 'A',
    reorderPoint: '10',
    reorderQuantity: '20',
    location: 'Main',
    isActive: true,
    qty: '4',
    value: '40',
    lastIn: '2026-06-20',
    lastOut: '2026-06-25',
  },
  // Discontinued: below its point too, but never suggested. Never sold, so dead.
  {
    itemId: 'b',
    name: 'Beta',
    sku: 'B',
    reorderPoint: '10',
    reorderQuantity: '5',
    location: 'Main',
    isActive: false,
    qty: '2',
    value: '30',
    lastIn: '2025-11-01',
    lastOut: null,
  },
  // Last went out exactly 180 days ago: not yet dead.
  {
    itemId: 'c',
    name: 'Gamma',
    sku: 'C',
    reorderPoint: '0',
    reorderQuantity: '0',
    location: 'Unassigned',
    isActive: true,
    qty: '50',
    value: '500',
    lastIn: '2025-12-31',
    lastOut: '2026-01-01',
  },
  // 181 days: dead.
  {
    itemId: 'd',
    name: 'Delta',
    sku: 'D',
    reorderPoint: '0',
    reorderQuantity: '0',
    location: 'Unassigned',
    isActive: true,
    qty: '7',
    value: '70',
    lastIn: '2025-10-01',
    lastOut: '2025-12-31',
  },
  // Out of stock: reorder, but nothing on hand to age or locate.
  {
    itemId: 'e',
    name: 'Epsilon',
    sku: 'E',
    reorderPoint: '3',
    reorderQuantity: '6',
    location: 'Main',
    isActive: true,
    qty: '0',
    value: '0',
    lastIn: '2026-01-15',
    lastOut: '2026-05-01',
  },
].map((i) => ({ ...i, qoh: '999', cost: '1', unvalued: 0 }));

/** The inventory account moving: stock in, then some of it sold. */
const BOOKS: PostingFixture[] = [
  {
    ref: 'JE-1',
    date: '2026-01-10',
    sourceType: 'po_receipt',
    lines: [
      ['1200', 1000, 0],
      ['2000', 0, 1000],
    ],
  },
  {
    ref: 'JE-2',
    date: '2026-03-10',
    sourceType: 'invoice',
    lines: [
      ['5000', 400, 0],
      ['1200', 0, 400],
    ],
  },
];

const run = async () => {
  const query = ledgerQuery(CHART, BOOKS, {
    extra: (sql) => {
      if (
        sql.includes('FROM inventory_items it') &&
        sql.includes('inventory_locations')
      )
        return ITEMS;
      if (sql.includes('COUNT(m.id)::int AS moves')) {
        return ITEMS.map((i) => ({
          itemId: i.itemId,
          itemName: i.name,
          sku: i.sku,
          category: 'General',
          qty: i.qty,
          value: i.value,
          moves: 1,
          unvalued: 0,
        }));
      }
      return undefined;
    },
  });
  return (await makeKpiService(query)).inventoryHealth('c1', AS_OF);
};

describe('ReportsKpiService — inventoryHealth', () => {
  it('reads a past date off the movement record', async () => {
    const h = await run();
    expect(h.asOfDate).toBe(AS_OF);
    expect(h.basis).toBe('movementRecord');
  });

  it('suggests reordering active items at or below their point — never a discontinued one', async () => {
    const h = await run();
    expect(h.belowReorder.map((x) => x.itemId)).toEqual(['a', 'e']);
    expect(h.belowReorder[0]).toMatchObject({
      qtyOnHand: 4,
      reorderPoint: 10,
      suggestedOrderQty: 20,
    });
    // max(reorderQuantity 6, reorderPoint 3 − 0)
    expect(h.belowReorder[1].suggestedOrderQty).toBe(6);
  });

  it('calls stock dead after more than 180 days without going out, or never having gone out', async () => {
    const h = await run();
    expect(h.deadStock.thresholdDays).toBe(180);
    expect(h.deadStock.items.map((x) => x.itemId)).toEqual(['d', 'b']);
    expect(
      h.deadStock.items.find((x) => x.itemId === 'b')!.lastOutboundDate,
    ).toBeNull();
    expect(h.deadStock.totalValue).toBe(100);
  });

  it('ages only the stock on hand, by last arrival and by last departure', async () => {
    const h = await run();
    const bucket = (list: any[], key: string) =>
      list.find((b) => b.key === key);
    expect(bucket(h.aging.byLastInbound, 'd0_30')).toMatchObject({
      count: 1,
      value: 40,
    });
    expect(bucket(h.aging.byLastInbound, 'd180_plus')).toMatchObject({
      count: 3,
      value: 600,
    });
    expect(bucket(h.aging.byLastOutbound, 'd0_30')).toMatchObject({
      count: 1,
      value: 40,
    });
    expect(bucket(h.aging.byLastOutbound, 'd91_180')).toMatchObject({
      count: 1,
      value: 500,
    });
    expect(bucket(h.aging.byLastOutbound, 'd180_plus')).toMatchObject({
      count: 1,
      value: 70,
    });
    expect(bucket(h.aging.byLastOutbound, 'noMovement')).toMatchObject({
      count: 1,
      value: 30,
    });
    const counted = h.aging.byLastInbound.reduce((t, b) => t + b.count, 0);
    expect(counted).toBe(h.totals.itemsOnHand);
  });

  it('places value and item counts by location, the largest first', async () => {
    const h = await run();
    expect(h.byLocation).toEqual([
      { location: 'Unassigned', value: 570, count: 2 },
      { location: 'Main', value: 70, count: 2 },
    ]);
  });

  it('ties its stock value to the valuation report for the same date', async () => {
    const h = await run();
    expect(h.totals).toEqual({
      itemCount: 5,
      itemsOnHand: 4,
      stockValue: 640,
      valuationTotal: 640,
    });
  });

  it('measures turnover off the ledger over twelve months', async () => {
    const h = await run();
    // COGS 400 ÷ average of twelve month-ends (Jul–Dec 0, Jan–Feb 1000, Mar–Jun 600).
    const avg = (2 * 1000 + 4 * 600) / 12;
    expect(h.turnover.key).toBe('inventoryTurnover');
    expect(h.turnover.value).toBe(Math.round((400 / avg) * 100) / 100);
    expect(h.dio.value).toBe(Math.round((avg / 400) * 365 * 100) / 100);
  });
});
