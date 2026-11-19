import {
  buildKpi,
  digestDayDue,
  digestMoney,
  isIsoDate,
  localDayBounds,
  localIsoDate,
  longDayLabel,
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
    },
    trendDates: [],
    documents: [],
    sales: { subtotal: 0, discount: 0, tax: 0, total: 245000, unpaid: 65000 },
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

  it('says so on a quiet day instead of a table of zeroes', () => {
    const quiet = { ...base(), isEmpty: true };
    const email = emailTemplates.daySummary(digestContent(quiet, 'Acme', 'x'));
    expect(email.html).toContain('Nothing was recorded');
    expect(email.text).toContain('Nothing was recorded on Thu 19 Nov 2026.');
  });
});
