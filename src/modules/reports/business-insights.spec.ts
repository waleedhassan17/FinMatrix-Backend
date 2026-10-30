import { buildBusinessInsights, type InsightInput } from './business-insights';
import type { ComparedKpi, KpiAssessmentLevel } from './reports.types';

const kpi = (
  key: string,
  current: number | null,
  prior: number | null = null,
  level: KpiAssessmentLevel = 'neutral',
): ComparedKpi => ({
  key,
  label: key,
  value: current,
  unit: 'ratio',
  formula: '',
  inputs: {},
  asOfDate: '2026-06-30',
  status: current === null ? 'no_denominator' : 'ok',
  assessment: { level, guide: '' },
  current,
  prior,
  change: null,
  changePct: null,
});

const BASE: InsightInput = {
  range: { startDate: '2026-01-01', endDate: '2026-06-30' },
  now: {
    revenue: 100_000,
    netIncome: 20_000,
    operatingExpenses: 30_000,
    endingCash: 80_000,
  },
  prior: {
    revenue: 100_000,
    netIncome: 20_000,
    operatingExpenses: 30_000,
    endingCash: 80_000,
  },
  kpis: [
    kpi('grossMarginPct', 40, 40, 'healthy'),
    kpi('netMarginPct', 20, 20, 'healthy'),
  ],
  top5SharePct: 30,
  budget: null,
};
const run = (patch: Partial<InsightInput>) =>
  buildBusinessInsights({ ...BASE, ...patch });
const find = (patch: Partial<InsightInput>, key: string) =>
  run(patch).find((x) => x.key === key);

describe('buildBusinessInsights', () => {
  it('reads a steady period as two calm lines that point at the P&L', () => {
    const out = run({});
    expect(out.map((x) => [x.key, x.tone])).toEqual([
      ['revenue', 'neutral'],
      ['margins', 'neutral'],
    ]);
    expect(out[0]).toEqual({
      key: 'revenue',
      tone: 'neutral',
      title: 'Revenue holding steady',
      detail: 'Rs 100,000 this period, within 5% of the previous one.',
      report: {
        key: 'profitLoss',
        params: { startDate: '2026-01-01', endDate: '2026-06-30' },
      },
    });
    expect(out[1].title).toBe('Keeping 20.0% of revenue as profit');
  });

  it.each([
    [125_000, 'positive', 'Revenue up 25.0%'],
    [90_000, 'warning', 'Revenue down 10.0%'],
    [75_000, 'negative', 'Revenue down 25.0%'],
  ])('reads revenue of %d against 100,000 as %s', (revenue, tone, title) => {
    const r = find({ now: { ...BASE.now, revenue } }, 'revenue')!;
    expect(r).toMatchObject({ tone, title });
    expect(r.detail).toBe(
      `Rs ${revenue.toLocaleString('en-US')} this period, against Rs 100,000 in the previous one.`,
    );
  });

  it('says so when there is nothing to compare revenue with, or no revenue at all', () => {
    const prior = { ...BASE.prior, revenue: 0 };
    expect(find({ prior }, 'revenue')).toMatchObject({
      tone: 'neutral',
      title: 'Rs 100,000 of revenue',
    });
    expect(
      find({ prior, now: { ...BASE.now, revenue: 0 } }, 'revenue'),
    ).toMatchObject({
      tone: 'warning',
      title: 'No revenue recorded',
    });
  });

  it('puts a loss before anything about margins', () => {
    const out = run({ now: { ...BASE.now, netIncome: -5_000 } });
    expect(out[0]).toMatchObject({
      key: 'netLoss',
      tone: 'negative',
      title: 'Net loss of Rs 5,000',
    });
    expect(
      out.some((x) => x.key === 'margins' || x.key === 'grossMargin'),
    ).toBe(false);
  });

  it('names a gross margin that moved two points or more', () => {
    const up = [kpi('grossMarginPct', 43.5, 40), kpi('netMarginPct', 20, 20)];
    expect(find({ kpis: up }, 'grossMargin')).toMatchObject({
      tone: 'positive',
      title: 'Gross margin improved to 43.5%',
      detail: 'Up 3.5 points on the previous period.',
    });
    const down = [kpi('grossMarginPct', 37, 40), kpi('netMarginPct', 20, 20)];
    expect(find({ kpis: down }, 'grossMargin')).toMatchObject({
      tone: 'warning',
      title: 'Gross margin slipped to 37.0%',
    });
  });

  it('reads cash: overdrawn, then runway, then the move', () => {
    const overdrawn = find(
      { now: { ...BASE.now, endingCash: -1_500 } },
      'overdrawn',
    )!;
    expect(overdrawn).toMatchObject({
      tone: 'negative',
      report: { key: 'cashFlow' },
    });
    expect(overdrawn.detail).toBe('The accounts end the period at −Rs 1,500.');

    const short = [...BASE.kpis, kpi('runwayMonths', 2.4, null, 'risk')];
    expect(find({ kpis: short }, 'runway')).toMatchObject({
      tone: 'negative',
      title: 'Cash covers about 2.4 months',
    });
    const thin = [...BASE.kpis, kpi('runwayMonths', 4, null, 'watch')];
    expect(find({ kpis: thin }, 'runway')).toMatchObject({ tone: 'warning' });

    expect(
      find({ now: { ...BASE.now, endingCash: 60_000 } }, 'cash'),
    ).toMatchObject({
      tone: 'warning',
      title: 'Cash down 25.0%',
    });
    expect(
      find({ now: { ...BASE.now, endingCash: 100_000 } }, 'cash'),
    ).toMatchObject({
      tone: 'positive',
      title: 'Cash up 25.0%',
    });
    expect(
      find({ now: { ...BASE.now, endingCash: 90_000 } }, 'cash'),
    ).toBeUndefined();
  });

  it('sends slow collections and a concentrated book to the aging report', () => {
    const slow = [...BASE.kpis, kpi('dso', 82, null, 'risk')];
    expect(find({ kpis: slow }, 'collections')).toMatchObject({
      tone: 'negative',
      title: 'Customers take 82 days to pay',
      report: { key: 'arAging', params: {} },
    });
    expect(
      find(
        { kpis: [...BASE.kpis, kpi('dso', 30, null, 'healthy')] },
        'collections',
      ),
    ).toBeUndefined();

    expect(find({ top5SharePct: 62 }, 'concentration')).toMatchObject({
      tone: 'warning',
      title: 'Top 5 customers are 62.0% of sales',
    });
    expect(find({ top5SharePct: 71 }, 'concentration')).toMatchObject({
      tone: 'negative',
    });
    expect(find({ top5SharePct: 50 }, 'concentration')).toBeUndefined();
    expect(find({ top5SharePct: null }, 'concentration')).toBeUndefined();
  });

  it('flags running costs that rose 15% or more', () => {
    expect(
      find({ now: { ...BASE.now, operatingExpenses: 34_500 } }, 'opex'),
    ).toMatchObject({
      tone: 'warning',
      title: 'Operating expenses up 15.0%',
    });
    expect(
      find({ now: { ...BASE.now, operatingExpenses: 34_000 } }, 'opex'),
    ).toBeUndefined();
  });

  describe('the budget', () => {
    const months = (budgeted: number, actualFirstHalf: number) =>
      Array.from({ length: 12 }, (_, i) => ({
        month: i + 1,
        budgeted,
        actual: i < 6 ? actualFirstHalf : 0,
      }));
    const budget = (expenseActual: number, revenueActual = 10_000) => ({
      id: 'b-1',
      fiscalYear: 2026,
      rows: [
        { accountType: 'expense', months: months(1_000, expenseActual) },
        { accountType: 'revenue', months: months(10_000, revenueActual) },
      ],
    });

    it('judges the range against the same months, not the whole year', () => {
      // Jan–Jun: 7,200 spent against 6,000 budgeted. Over the whole year it
      // would read as well within a 12,000 budget.
      expect(find({ budget: budget(1_200) }, 'budget')).toEqual({
        key: 'budget',
        tone: 'negative',
        title: 'Spending 20.0% over budget',
        detail: 'Rs 7,200 spent against Rs 6,000 budgeted for the same months.',
        report: { key: 'budgets', params: { budgetId: 'b-1' } },
      });
      expect(find({ budget: budget(1_100) }, 'budget')).toMatchObject({
        tone: 'warning',
      });
      expect(find({ budget: budget(900) }, 'budget')).toMatchObject({
        tone: 'positive',
        title: 'Spending within budget',
      });
    });

    it('warns when revenue runs 10% or more behind its budget', () => {
      expect(
        find({ budget: budget(1_000, 8_000) }, 'revenueBudget'),
      ).toMatchObject({
        tone: 'warning',
        title: 'Revenue 20.0% behind budget',
        detail: 'Rs 48,000 against Rs 60,000 budgeted for the same months.',
      });
      expect(
        find({ budget: budget(1_000, 9_500) }, 'revenueBudget'),
      ).toBeUndefined();
    });

    it('says nothing about a budget with nothing budgeted for the months', () => {
      const empty = {
        id: 'b-2',
        fiscalYear: 2026,
        rows: [{ accountType: 'expense', months: months(0, 500) }],
      };
      expect(find({ budget: empty }, 'budget')).toBeUndefined();
    });
  });

  it('leads with what needs attention, and stops at six', () => {
    const out = run({
      now: {
        revenue: 70_000,
        netIncome: -1_000,
        operatingExpenses: 40_000,
        endingCash: 50_000,
      },
      kpis: [
        ...BASE.kpis,
        kpi('dso', 60, null, 'watch'),
        kpi('runwayMonths', 4, null, 'watch'),
      ],
      top5SharePct: 75,
      budget: {
        id: 'b-1',
        fiscalYear: 2026,
        rows: [
          {
            accountType: 'expense',
            months: Array.from({ length: 12 }, (_, i) => ({
              month: i + 1,
              budgeted: 1_000,
              actual: 1_060,
            })),
          },
        ],
      },
    });
    expect(out).toHaveLength(6);
    const rank = { negative: 0, warning: 1, positive: 2, neutral: 3 };
    const tones = out.map((x) => rank[x.tone]);
    expect([...tones].sort((a, b) => a - b)).toEqual(tones);
    expect(out.slice(0, 3).map((x) => x.key)).toEqual([
      'revenue',
      'netLoss',
      'concentration',
    ]);
  });
});
