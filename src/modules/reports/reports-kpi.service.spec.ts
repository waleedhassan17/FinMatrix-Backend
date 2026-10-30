import {
  healthKpis,
  type HealthInputs,
  INVENTORY_MOVEMENT_DIRECTION,
} from './reports-kpi.service';
import {
  CASH_BOOKS,
  CHART,
  LOOK_THROUGH,
  ledgerQuery,
  makeKpiService,
  makeService,
} from '../../../test/reports-ledger-fixture';
import {
  businessToday,
  addDaysIso,
} from '../../common/utils/business-date.util';

const BASE: HealthInputs = {
  cashAndBank: 9000,
  receivables: 3000,
  inventory: 6000,
  currentAssets: 18000,
  currentLiabilities: 6000,
  accountsPayable: 4500,
  totalLiabilities: 10000,
  totalEquity: 20000,
  revenue90: 27000,
  cogs90: 13500,
  avgMonthlyNetCash: -3000,
};
const byKey = (inputs: HealthInputs) =>
  Object.fromEntries(healthKpis(inputs, '2026-10-26').map((k) => [k.key, k]));

describe('healthKpis — the formulas', () => {
  it('computes every KPI from its inputs', () => {
    const k = byKey(BASE);
    expect(k.cashAndBank.value).toBe(9000);
    expect(k.workingCapital.value).toBe(12000);
    expect(k.currentRatio.value).toBe(3);
    expect(k.quickRatio.value).toBe(2); // (9000 + 3000) ÷ 6000
    expect(k.debtToEquity.value).toBe(0.5);
    expect(k.dso.value).toBe(10); // 3000 ÷ 27000 × 90
    expect(k.dpo.value).toBe(30); // 4500 ÷ 13500 × 90
    expect(k.dio.value).toBe(40); // 6000 ÷ 13500 × 90
    expect(k.ccc.value).toBe(20); // 10 + 40 − 30
    expect(k.runwayMonths.value).toBe(3); // 9000 ÷ 3000
    for (const x of Object.values(k)) {
      expect(x.status).toBe('ok');
      expect(x.formula).toBeTruthy();
      expect(x.asOfDate).toBe('2026-10-26');
    }
  });

  it('returns null with a reason when a denominator is zero — never Infinity or NaN', () => {
    const k = byKey({
      ...BASE,
      currentLiabilities: 0,
      revenue90: 0,
      cogs90: 0,
    });
    for (const key of [
      'currentRatio',
      'quickRatio',
      'dso',
      'dpo',
      'dio',
      'ccc',
    ]) {
      expect(k[key].value).toBeNull();
      expect(k[key].status).toBe('no_denominator');
    }
    // Working capital has no denominator and is still reported.
    expect(k.workingCapital.value).toBe(18000);
  });

  it('declines days-outstanding when revenue or COGS nets to zero or below', () => {
    // A quarter whose voids outweigh its sales: no meaningful DSO, not a
    // negative one.
    const k = byKey({ ...BASE, revenue90: -1500, cogs90: -10 });
    for (const key of ['dso', 'dpo', 'dio', 'ccc']) {
      expect(k[key].value).toBeNull();
      expect(k[key].status).toBe('no_denominator');
    }
  });

  it('declines debt-to-equity when equity is zero or negative', () => {
    for (const equity of [0, -500]) {
      const d = byKey({ ...BASE, totalEquity: equity }).debtToEquity;
      expect(d.value).toBeNull();
      expect(d.status).toBe('negative_equity');
    }
  });

  it('reports runway only while cash is falling', () => {
    const k = byKey({ ...BASE, avgMonthlyNetCash: 500 });
    expect(k.runwayMonths.value).toBeNull();
    expect(k.runwayMonths.status).toBe('cash_positive');
    expect(byKey({ ...BASE, avgMonthlyNetCash: 0 }).runwayMonths.status).toBe(
      'cash_positive',
    );
    // Overdrawn and still burning: no runway left, not a negative one.
    expect(byKey({ ...BASE, cashAndBank: -100 }).runwayMonths.value).toBe(0);
  });

  it('keeps every value finite or null', () => {
    const k = healthKpis(
      { ...BASE, currentLiabilities: 1e-9, cogs90: -0 },
      '2026-10-26',
    );
    for (const x of k)
      expect(x.value === null || Number.isFinite(x.value)).toBe(true);
  });
});

describe('INVENTORY_MOVEMENT_DIRECTION', () => {
  it('classifies every movement type', () => {
    expect(INVENTORY_MOVEMENT_DIRECTION).toEqual({
      receipt: 'inbound',
      return: 'inbound',
      sale: 'outbound',
      delivery: 'outbound',
      transfer: 'neutral',
      adjustment: 'neutral',
    });
  });
});

describe('ReportsKpiService — financial health from the ledger', () => {
  it('reads its inputs off the statements as of the date', async () => {
    const kpi = await makeKpiService(
      ledgerQuery(CHART, CASH_BOOKS, { lookThrough: LOOK_THROUGH }),
    );
    const h = await kpi.financialHealth('c1', '2026-12-31');
    const k = Object.fromEntries(h.kpis.map((x) => [x.key, x]));
    expect(k.cashAndBank.value).toBe(34500);
    // Current assets: cash 34500 + AR 2000 + inventory 1000; liabilities: AP 2500.
    expect(k.workingCapital.value).toBe(37500 - 2500);
    expect(k.quickRatio.inputs).toEqual({
      cashAndBank: 34500,
      receivables: 2000,
      currentLiabilities: 2500,
    });
    // The 2700 loan is long-term, so it is in debt but not current liabilities.
    expect(k.debtToEquity.inputs.totalLiabilities).toBe(22500);
  });
});

describe('ReportsKpiService — analytics', () => {
  const svcs = async () => {
    const q = ledgerQuery(CHART, CASH_BOOKS, { lookThrough: LOOK_THROUGH });
    return { kpi: await makeKpiService(q), reports: await makeService(q) };
  };

  it('adds the monthly series up to the P&L for the range, to the paisa', async () => {
    const { kpi, reports } = await svcs();
    const a = await kpi.analytics('c1', '2026-01-01', '2026-12-31');
    const pl = await reports.profitLoss('c1', '2026-01-01', '2026-12-31');
    const sum = (k: 'revenue' | 'netIncome' | 'cogs' | 'operatingExpenses') =>
      a.series.reduce((t, p) => t + p[k], 0);
    expect(a.series).toHaveLength(12);
    expect(sum('revenue')).toBeCloseTo(pl.revenue, 10);
    expect(sum('netIncome')).toBeCloseTo(pl.netIncome, 10);
    expect(sum('cogs')).toBeCloseTo(pl.cogs, 10);
    expect(sum('operatingExpenses')).toBeCloseTo(pl.totalExpenses, 10);
  });

  it('compares with the preceding period of equal length', async () => {
    const { kpi } = await svcs();
    const a = await kpi.analytics('c1', '2026-07-01', '2026-12-31');
    // Whole months: the six months before, not 184 days.
    expect(a.comparisonRange).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-06-30',
    });
    const revenue = a.kpis.find((k) => k.key === 'revenue')!;
    expect(revenue).toMatchObject({
      current: 0,
      prior: 6000,
      change: -6000,
      changePct: -100,
    });
    const margin = a.kpis.find((k) => k.key === 'grossMarginPct')!;
    // No revenue this period: no margin, and so no change to report.
    expect(margin).toMatchObject({
      current: null,
      status: 'no_denominator',
      change: null,
    });
  });

  it('sums operating cash by month to the statement and labels sales by customer as invoice basis', async () => {
    const { kpi, reports } = await svcs();
    const a = await kpi.analytics('c1', '2026-01-01', '2026-12-31');
    const cf = await reports.cashFlow('c1', '2026-01-01', '2026-12-31');
    expect(a.series.reduce((t, p) => t + p.operatingCashFlow, 0)).toBeCloseTo(
      cf.operating.total,
      10,
    );
    expect(a.series[11].endingCash).toBe(cf.endingCash);
    expect(a.salesByCustomer.basis).toBe('invoice');
    expect(a.budgetVsActual).toBeNull();
  });

  it('judges every KPI and says what stands out, each pointing at a report', async () => {
    const { kpi } = await svcs();
    const a = await kpi.analytics('c1', '2026-01-01', '2026-12-31');
    for (const k of a.kpis) {
      expect(['healthy', 'watch', 'risk', 'neutral']).toContain(k.assessment.level);
      expect(k.assessment.guide).toMatch(/\.$/);
    }
    // Gross and net profit are KPIs in their own right, each the P&L's figure.
    const pl = await (await svcs()).reports.profitLoss('c1', '2026-01-01', '2026-12-31');
    expect(a.kpis.find((k) => k.key === 'grossProfit')).toMatchObject({
      value: pl.grossProfit,
      unit: 'money',
      assessment: { level: 'healthy' },
    });
    expect(a.kpis.find((k) => k.key === 'netIncome')).toMatchObject({
      value: pl.netIncome,
      prior: 0,
      label: 'Net profit',
    });
    // Cash is not falling over the last three months: runway reads healthy.
    expect(a.kpis.find((k) => k.key === 'runwayMonths')).toMatchObject({
      status: 'cash_positive',
      assessment: { level: 'healthy' },
    });
    // 2025 had no revenue to compare with; cash rose from 10,000 to 34,500.
    expect(a.insights.map((i) => [i.key, i.tone])).toEqual([
      ['cash', 'positive'],
      ['revenue', 'neutral'],
      ['margins', 'neutral'],
    ]);
    expect(a.insights[0]).toMatchObject({
      title: 'Cash up 245.0%',
      detail: 'Rs 34,500 at the end of the period, from Rs 10,000.',
      report: {
        key: 'cashFlow',
        params: { startDate: '2026-01-01', endDate: '2026-12-31' },
      },
    });
  });

  it('names as many expense accounts and customers as asked, folding the rest into Other', async () => {
    const chart = [
      ...CHART,
      { code: '6100', name: 'Salaries', type: 'expense', subType: 'Operating' },
      { code: '6200', name: 'Utilities', type: 'expense', subType: 'Operating' },
      { code: '6400', name: 'Fuel', type: 'expense', subType: 'Operating' },
      { code: '6500', name: 'Repairs', type: 'expense', subType: 'Operating' },
    ];
    const spend = (ref: string, code: string, amount: number) => ({
      ref,
      date: '2026-07-01',
      sourceType: 'journal_entry',
      lines: [
        [code, amount, 0],
        ['1000', 0, amount],
      ] as Array<[string, number, number]>,
    });
    const books = [
      ...CASH_BOOKS,
      spend('JE-X1', '6000', 900),
      spend('JE-X2', '6100', 800),
      spend('JE-X3', '6200', 300),
      spend('JE-X4', '6400', 200),
      spend('JE-X5', '6500', 100),
    ];
    const customers = Array.from({ length: 8 }, (_, i) => ({
      customerId: `cu-${i + 1}`,
      name: `Customer ${i + 1}`,
      amount: String(1000 - i * 100),
      invoices: 1,
    }));
    const q = ledgerQuery(chart, books, {
      lookThrough: LOOK_THROUGH,
      extra: (sql) =>
        sql.includes('FROM invoices i LEFT JOIN customers c') ? customers : undefined,
    });
    const kpi = await makeKpiService(q);
    const pl = await (await makeService(q)).profitLoss('c1', '2026-01-01', '2026-12-31');

    const a = await kpi.analytics('c1', '2026-01-01', '2026-12-31', {
      expenseTop: 3,
      customerTop: 5,
    });
    // Office supplies 1,000 · Rent 900 · Salaries 800, then Other.
    expect(a.expenseByAccount.map((x) => x.accountName)).toEqual([
      'Office Supplies',
      'Rent Expense',
      'Salaries',
      'Other',
    ]);
    expect(a.expenseByAccount[3].amount).toBe(600);
    expect(a.expenseByAccount.reduce((t, x) => t + x.amount, 0)).toBe(pl.totalExpenses);
    // Each slice carries its share of the whole, so neither client divides.
    expect(a.expenseByAccount.map((x) => x.sharePct)).toEqual([
      (1000 / 3300) * 100,
      (900 / 3300) * 100,
      (800 / 3300) * 100,
      (600 / 3300) * 100,
    ].map((x) => Math.round(x * 100) / 100));
    expect(a.salesByCustomer.customers).toHaveLength(5);
    expect(a.salesByCustomer.customers[0].sharePct).toBe(19.23);
    expect(a.salesByCustomer.other).toEqual({ count: 3, amount: 1200, sharePct: 23.08 });
    // Top five: 4,000 of 5,200.
    expect(a.salesByCustomer.top5SharePct).toBe(76.92);
    expect(a.salesByCustomer.assessment.level).toBe('risk');

    // Bounded: a pie of one, or of fifty, is not on offer.
    const tiny = await kpi.analytics('c1', '2026-01-01', '2026-12-31', { expenseTop: 1 });
    expect(tiny.expenseByAccount).toHaveLength(4);
    const wide = await kpi.analytics('c1', '2026-01-01', '2026-12-31', { customerTop: 50 });
    expect(wide.salesByCustomer.customers).toHaveLength(8);
    // The defaults are unchanged: eight accounts, ten customers.
    const plain = await kpi.analytics('c1', '2026-01-01', '2026-12-31');
    expect(plain.expenseByAccount).toHaveLength(6);
    expect(plain.salesByCustomer.other.count).toBe(0);
  });

  it('refuses a range longer than 60 months', async () => {
    const { kpi } = await svcs();
    await expect(
      kpi.analytics('c1', '2020-01-01', '2026-12-31'),
    ).rejects.toMatchObject({
      response: { code: 'RANGE_TOO_LONG' },
    });
  });
});

describe('ReportsService — aging insights', () => {
  const today = businessToday();
  const due = (days: number) => addDaysIso(today, -days);
  const docs = [
    {
      customerId: 'c-a',
      customerName: 'Acme',
      balance: '1000.005',
      dueDate: due(45),
    },
    {
      customerId: 'c-a',
      customerName: 'Acme',
      balance: '500',
      dueDate: due(-3),
    },
    {
      customerId: 'c-b',
      customerName: 'Beta',
      balance: '250.335',
      dueDate: due(5),
    },
    {
      customerId: 'c-b',
      customerName: 'Beta',
      balance: '300',
      dueDate: due(-20),
    },
    {
      customerId: 'c-c',
      customerName: 'Gamma',
      balance: '99.99',
      dueDate: due(-90),
    },
    {
      customerId: 'c-d',
      customerName: 'Delta',
      balance: '10',
      dueDate: due(0),
    },
  ];
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('report_preferences')) return [];
    if (sql.includes('FROM invoices i JOIN customers c')) return docs;
    if (
      sql.includes('FROM customers c WHERE c.company_id = $1 AND c.id = ANY')
    ) {
      return [
        { id: 'c-a', paymentTerms: 'net30', creditLimit: '1000' },
        { id: 'c-b', paymentTerms: 'net15', creditLimit: '0' },
      ];
    }
    if (sql.includes('DISTINCT ON (p.customer_id)'))
      return [{ partyId: 'c-a', date: '2026-09-01', amount: '400' }];
    return [];
  });

  it('foots the schedule to the open total, which is the aging grand total', async () => {
    const r: any = await (
      await makeService(query)
    ).arAging('c1', undefined, { withInsights: true });
    const sumSchedule = r.insights.schedule.reduce(
      (t: number, s: any) => t + s.amount,
      0,
    );
    expect(sumSchedule).toBeCloseTo(r.insights.totalOpen, 10);
    expect(r.insights.totalOpen).toBe(r.totals.total);
    expect(r.insights.schedule.map((s: any) => s.key)).toEqual([
      'overdue',
      'd0_7',
      'd8_14',
      'd15_30',
      'd31_60',
      'd60_plus',
    ]);
    expect(
      r.insights.schedule.reduce((t: number, s: any) => t + s.count, 0),
    ).toBe(docs.length);
  });

  it('weights lateness by balance and names the parties behind the book', async () => {
    const r: any = await (
      await makeService(query)
    ).arAging('c1', undefined, { withInsights: true });
    // Overdue: 1000.005 at 45 days and 250.335 at 5 days.
    expect(r.insights.overdue).toBe(1250.34);
    expect(r.insights.weightedAvgDaysOverdue).toBeCloseTo(
      (1000.005 * 45 + 250.335 * 5) / 1250.34,
      2,
    );
    const acme = r.rows.find((x: any) => x.customerId === 'c-a');
    expect(acme).toMatchObject({
      paymentTerms: 'net30',
      creditLimit: 1000,
      overLimit: true,
      creditUsedPct: 150,
      lastPaymentDate: '2026-09-01',
      lastPaymentAmount: 400,
      oldestDueDate: due(45),
    });
    const beta = r.rows.find((x: any) => x.customerId === 'c-b');
    expect(beta).toMatchObject({
      creditLimit: 0,
      overLimit: false,
      creditUsedPct: null,
      lastPaymentDate: null,
    });
  });

  it('adds nothing unless asked — the CSV export and the dashboard see the old shape', async () => {
    const r: any = await (await makeService(query)).arAging('c1');
    expect(r.insights).toBeUndefined();
    expect(r.rows[0].paymentTerms).toBeUndefined();
  });
});
