import {
  bestSellers,
  buildItemSheet,
  buildKpi,
  comparePeriod,
  digestDayDue,
  digestMoney,
  isIsoDate,
  isoDayCount,
  ItemFigures,
  localDayBounds,
  localIsoDate,
  longDayLabel,
  marginOf,
  summaryWindow,
} from './day-summary.util';
import { digestContent } from './day-summary-cron.service';
import { emailTemplates } from '../mail/mail.templates';
import { DayKpi, DaySummaryResponse } from './day-summary.types';

const KHI = 'Asia/Karachi';

describe('day-summary util', () => {
  it('accepts only real calendar dates', () => {
    expect(isIsoDate('2026-11-19')).toBe(true);
    expect(isIsoDate('2026-02-30')).toBe(false);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('19-11-2026')).toBe(false);
    expect(isIsoDate(undefined)).toBe(false);
  });

  it('bounds a Karachi day in UTC (midnight PKT is 19:00 UTC the day before)', () => {
    const b = localDayBounds('2026-11-19', KHI);
    expect(b.start.toISOString()).toBe('2026-11-18T19:00:00.000Z');
    expect(b.end.toISOString()).toBe('2026-11-19T19:00:00.000Z');
  });

  it('reads the local calendar date of an instant', () => {
    // 22:30 UTC on the 18th is 03:30 on the 19th in Karachi.
    expect(localIsoDate(new Date('2026-11-18T22:30:00Z'), KHI)).toBe(
      '2026-11-19',
    );
  });

  describe('digestDayDue', () => {
    const at = (iso: string) => new Date(iso);
    it('is not due before the hour', () => {
      // 20:59 PKT
      expect(digestDayDue(at('2026-11-19T15:59:00Z'), KHI, 21)).toBeNull();
    });
    it('an evening digest covers that same day, and stays due until midnight', () => {
      expect(digestDayDue(at('2026-11-19T16:10:00Z'), KHI, 21)).toBe(
        '2026-11-19',
      );
      expect(digestDayDue(at('2026-11-19T18:50:00Z'), KHI, 21)).toBe(
        '2026-11-19',
      );
    });
    it('a morning digest covers the day before', () => {
      // 08:10 PKT on the 20th
      expect(digestDayDue(at('2026-11-20T03:10:00Z'), KHI, 8)).toBe(
        '2026-11-19',
      );
    });
  });

  it('reads the week before a date: previous day, same day last week, 7-day trend', () => {
    const w = summaryWindow('2026-11-19');
    expect(w.from).toBe('2026-11-12');
    expect(w.previousDay).toBe('2026-11-18');
    expect(w.sameDayLastWeek).toBe('2026-11-12');
    expect(w.trendDates).toEqual([
      '2026-11-13',
      '2026-11-14',
      '2026-11-15',
      '2026-11-16',
      '2026-11-17',
      '2026-11-18',
      '2026-11-19',
    ]);
  });

  it('builds a headline figure with its comparisons, filling empty days with zero', () => {
    const k = buildKpi(
      new Map([
        ['2026-11-19', { count: 3, total: 1500.004 }],
        ['2026-11-18', { count: 1, total: 500 }],
        ['2026-11-12', { count: 2, total: 900 }],
      ]),
      '2026-11-19',
    );
    expect(k.count).toBe(3);
    expect(k.total).toBe(1500);
    expect(k.previousDay).toEqual({ count: 1, total: 500 });
    expect(k.sameDayLastWeek).toEqual({ count: 2, total: 900 });
    expect(k.trend).toEqual([0, 0, 0, 0, 0, 500, 1500]);
  });

  it('formats digest money and day labels', () => {
    expect(digestMoney('PKR', 245000)).toBe('Rs 245,000');
    expect(digestMoney('PKR', 1234.5)).toBe('Rs 1,234.50');
    expect(digestMoney('USD', 10)).toBe('USD 10');
    expect(longDayLabel('2026-11-19')).toBe('Thu 19 Nov 2026');
  });
});

describe('day-summary digest content', () => {
  const kpi = (count: number, total: number, prev = 0): DayKpi => ({
    count,
    total,
    previousDay: { count: 0, total: prev },
    sameDayLastWeek: { count: 0, total: 0 },
    trend: [0, 0, 0, 0, 0, prev, total],
  });
  const base = (): DaySummaryResponse => ({
    date: '2026-11-19',
    today: '2026-11-19',
    timezone: KHI,
    currency: 'PKR',
    scope: { ownOnly: false, createdBy: null },
    kinds: ['invoice', 'receipt', 'bill', 'vendor_payment'],
    headline: {
      sales: kpi(12, 245000, 200000),
      received: kpi(5, 180000),
      orders: null,
      purchases: kpi(1, 40000),
      purchaseOrders: null,
      goodsReceived: null,
    },
    trendDates: [],
    documents: [],
    sales: {
      subtotal: 0,
      discount: 0,
      tax: 0,
      total: 245000,
      unpaid: 65000,
      returns: 0,
      net: 245000,
    },
    cash: { methods: [], received: 180000, paid: 0, net: 180000 },
    topCustomers: [{ id: 'c1', name: 'Ali <Traders>', count: 3, total: 90000 }],
    topItems: [],
    hourly: [],
    team: null,
    members: null,
    profit: {
      revenue: 245000,
      cogs: 150000,
      grossProfit: 95000,
      expenses: 0,
      netIncome: 95000,
    },
    attention: {
      backdated: 2,
      drafts: 1,
      cancelledOrders: 0,
      voided: { count: 1, total: 5000 },
    },
    purchasing: null,
    isEmpty: false,
    generatedAt: '',
  });

  it('lays out the headline rows with counts and the change against yesterday', () => {
    const c = digestContent(base(), 'Acme', 'https://app/x');
    expect(c.rows[0]).toEqual({
      label: 'Sales',
      value: 'Rs 245,000',
      note: '12 invoices · +23% vs yesterday',
    });
    expect(c.rows.map((r) => r.label)).toEqual([
      'Sales',
      'Money received',
      'Purchases',
      'Still unpaid from these sales',
      'Gross profit',
    ]);
    expect(c.attention).toEqual([
      '2 entries made today but dated earlier',
      '1 draft not yet posted',
      '1 document voided or deleted (Rs 5,000)',
    ]);
  });

  it('renders the email, escaping names', () => {
    const email = emailTemplates.daySummary(
      digestContent(
        base(),
        'Acme & Sons',
        'https://app/reports/day-summary?date=2026-11-19',
      ),
    );
    expect(email.subject).toBe('Day summary — Acme & Sons, Thu 19 Nov 2026');
    expect(email.html).toContain('Ali &lt;Traders&gt;');
    expect(email.html).toContain('Acme &amp; Sons');
    expect(email.html).not.toContain('Ali <Traders>');
    expect(email.text).toContain(
      'Sales: Rs 245,000 (12 invoices · +23% vs yesterday)',
    );
  });

  it('adds the buying rows and the overdue warning for a business with purchase orders', () => {
    const s = base();
    s.headline.purchaseOrders = kpi(3, 90000, 45000);
    s.headline.goodsReceived = kpi(2, 74000);
    s.attention.cancelledOrders = 1;
    s.purchasing = {
      placed: { count: 3, total: 90000 },
      received: { count: 2, total: 74000 },
      billed: { count: 1, total: 40000 },
      topVendors: [],
      position: {
        open: { count: 4, total: 120000 },
        overdue: { count: 2, total: 35000, oldest: '2026-11-10' },
        receivedNotBilled: { count: 1, total: 34000 },
      },
    };
    const c = digestContent(s, 'Acme', 'x');
    expect(c.rows.map((r) => r.label)).toEqual([
      'Sales',
      'Money received',
      'Purchase orders',
      'Goods received',
      'Purchases',
      'Still unpaid from these sales',
      'Gross profit',
    ]);
    expect(c.rows[2]).toEqual({
      label: 'Purchase orders',
      value: 'Rs 90,000',
      note: '3 placed · +100% vs yesterday',
    });
    expect(c.rows[3].note).toBe('at cost, on 2 purchase orders');
    expect(c.attention).toContain('1 order cancelled or withdrawn');
    expect(c.attention).toContain(
      '2 purchase orders overdue (Rs 35,000 still to arrive)',
    );
  });

  it('says so on a quiet day instead of a table of zeroes', () => {
    const quiet = { ...base(), isEmpty: true };
    const email = emailTemplates.daySummary(digestContent(quiet, 'Acme', 'x'));
    expect(email.html).toContain('Nothing was recorded');
    expect(email.text).toContain('Nothing was recorded on Thu 19 Nov 2026.');
  });
});

describe('item-wise sales sheet', () => {
  const fig = (over: Partial<ItemFigures>): ItemFigures => ({
    kind: 'item',
    itemId: 'i1',
    serviceKey: null,
    name: 'Lactogen 1 400G',
    code: '001-006',
    unit: 'tin',
    category: 'NESTLE POWDER',
    agency: 'Nestle',
    sold: 0,
    free: 0,
    returned: 0,
    value: 0,
    returnsValue: 0,
    cost: 0,
    costMissing: false,
    ...over,
  });

  it('counts days and compares with the period just before, or a week earlier', () => {
    expect(isoDayCount('2026-10-25', '2026-10-25')).toBe(1);
    expect(isoDayCount('2026-10-25', '2026-10-26')).toBe(2);
    expect(isoDayCount('2024-01-01', '2024-12-31')).toBe(366);
    expect(comparePeriod('2026-10-26', '2026-10-26', 'previous')).toEqual({
      from: '2026-10-25',
      to: '2026-10-25',
    });
    expect(comparePeriod('2026-10-25', '2026-10-26', 'previous')).toEqual({
      from: '2026-10-23',
      to: '2026-10-24',
    });
    expect(comparePeriod('2026-10-25', '2026-10-26', 'lastWeek')).toEqual({
      from: '2026-10-18',
      to: '2026-10-19',
    });
  });

  it('nets sold + free − returned, and gives the owner cost, profit and margin', () => {
    const s = buildItemSheet(
      [
        fig({
          sold: 12,
          free: 1,
          returned: 2,
          value: 9000,
          returnsValue: 1800,
          cost: 7150,
        }),
      ],
      null,
      true,
    );
    expect(s.rows[0]).toMatchObject({
      sold: 12,
      free: 1,
      returned: 2,
      net: 11,
      value: 9000,
      returnsValue: 1800,
      cost: 7150,
      profit: 1850,
      margin: 20.6,
      compareValue: null,
    });
    expect(s.hasFree).toBe(true);
    expect(s.totals).toMatchObject({ lines: 1, net: 11, value: 9000 });
  });

  it('hides cost, profit and margin from staff', () => {
    const s = buildItemSheet(
      [fig({ sold: 1, value: 100, cost: 60, costMissing: true })],
      null,
      false,
    );
    expect(s.rows[0]).toMatchObject({
      cost: null,
      profit: null,
      margin: null,
      costMissing: false,
    });
    expect(s.totals).toMatchObject({ cost: null, profit: null, margin: null });
  });

  it('puts items before services, largest net sales first', () => {
    const s = buildItemSheet(
      [
        fig({
          kind: 'service',
          itemId: null,
          serviceKey: 'delivery charge',
          name: 'Delivery charge',
          value: 5000,
        }),
        fig({ itemId: 'a', name: 'Bunyad 900G', sold: 1, value: 700 }),
        fig({ itemId: 'b', name: 'Nido 3+ 375G', sold: 2, value: 2100 }),
      ],
      null,
      true,
    );
    expect(s.rows.map((r) => r.name)).toEqual([
      'Nido 3+ 375G',
      'Bunyad 900G',
      'Delivery charge',
    ]);
    expect(s.hasFree).toBe(false);
    // A charge has no cost of goods: no profit or margin of its own, and the
    // sheet's profit and margin are the stock items'.
    expect(s.rows[2]).toMatchObject({ cost: null, profit: null, margin: null });
    expect(s.totals).toMatchObject({ value: 7800, cost: 0, profit: 2800 });
    expect(s.totals.margin).toBe(100);
  });

  it('compares each line, and keeps lines sold only before so group totals add up', () => {
    const s = buildItemSheet(
      [fig({ itemId: 'a', sold: 3, value: 300 })],
      [
        fig({ itemId: 'a', sold: 2, value: 200 }),
        fig({ itemId: 'gone', name: 'Cerelac Rice', sold: 1, value: 450 }),
      ],
      true,
    );
    expect(s.rows[0].compareValue).toBe(200);
    expect(s.compareOnly).toEqual([
      expect.objectContaining({
        itemId: 'gone',
        compareValue: 450,
        category: 'NESTLE POWDER',
      }),
    ]);
    expect(s.totals.compareValue).toBe(650);
  });

  it('a margin needs a value; a line only returned has a negative value', () => {
    expect(marginOf(10, 0)).toBeNull();
    expect(marginOf(-50, 200)).toBe(-25);
    const s = buildItemSheet(
      [fig({ returned: 1, value: -100, returnsValue: 100, cost: -60 })],
      null,
      true,
    );
    expect(s.rows[0]).toMatchObject({ net: -1, value: -100, profit: -40 });
  });

  it('best sellers are the sheet’s top lines, never a line that only came back', () => {
    const top = bestSellers([
      fig({ itemId: 'a', name: 'A', sold: 1, value: 100 }),
      fig({
        itemId: 'b',
        name: 'B',
        sold: 5,
        free: 1,
        returned: 1,
        value: 900,
      }),
      fig({ itemId: 'c', name: 'C', returned: 2, value: -200 }),
      fig({ itemId: 'd', name: 'D', free: 3, value: 0 }),
    ]);
    expect(top).toEqual([
      { itemId: 'b', name: 'B', quantity: 5, total: 900 },
      { itemId: 'a', name: 'A', quantity: 1, total: 100 },
    ]);
  });
});
