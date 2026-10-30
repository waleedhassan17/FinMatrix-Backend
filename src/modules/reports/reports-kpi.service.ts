import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ReportsService,
  apportionRounding,
  monthSpan,
  monthWindow,
} from './reports.service';
import { BudgetsService } from '../budgets/budgets.service';
import { dayBefore, fiscalYearStart, precedingPeriod } from './fiscal-year';
import {
  addDaysIso,
  businessToday,
  daysBetweenIso,
} from '../../common/utils/business-date.util';
import {
  AGE_BUCKETS,
  DEAD_STOCK_DAYS,
  INBOUND_SQL,
  OUTBOUND_SQL,
} from './inventory-movement-rules';
import { isDeadStock, suggestedOrderQty } from './item-stock';
import { buildBusinessInsights } from './business-insights';
import { assessKpi } from './kpi-benchmarks';
import type {
  ComparedKpi,
  Kpi,
  KpiStatus,
  KpiUnit,
  InventoryHealth,
} from './reports.types';

// Kept importable from here, where it has always been.
export { INVENTORY_MOVEMENT_DIRECTION } from './inventory-movement-rules';

/**
 * The ONLY place a KPI formula lives.
 *
 * The Expo app and the website used to compute their own ratios from whatever
 * figures each happened to fetch, so the same company could show a current
 * ratio of 1.8 on a phone and 2.1 in a browser. Every KPI is now computed here,
 * once, from the statements ReportsService produces, and returned with its
 * formula and the inputs it used — a reader can always check the arithmetic.
 *
 * A KPI whose denominator is zero has value null and a status saying why;
 * never Infinity, never NaN. Groups come from classifyForStatement via the
 * balance sheet's sections, so "current assets" means the same thing here as
 * on the statement.
 */

const r2 = (n: number) => Math.round(n * 100) / 100;
const EPS = 0.00005;

/** a ÷ b, or null when b is (effectively) zero. */
const div = (a: number, b: number): number | null =>
  Math.abs(b) > EPS ? a / b : null;

/**
 * a ÷ b for a rate over a flow (days of sales, days of cost, turnover): only
 * defined when the flow is POSITIVE. Revenue or COGS that nets to zero or
 * below over the window — a quarter whose voids and returns outweigh its
 * sales — has no meaningful "days outstanding", and dividing by it produces
 * a negative number of days that reads as a figure. Null instead.
 */
const divByFlow = (a: number, b: number): number | null =>
  b > EPS ? a / b : null;

function kpi(
  key: string,
  label: string,
  unit: KpiUnit,
  formula: string,
  inputs: Record<string, number | null>,
  asOfDate: string,
  value: number | null,
  status?: KpiStatus,
): Kpi {
  const v = value === null || !Number.isFinite(value) ? null : r2(value);
  const finalStatus: KpiStatus = status ?? (v === null ? 'no_denominator' : 'ok');
  return {
    key,
    label,
    value: v,
    unit,
    formula,
    inputs: Object.fromEntries(
      Object.entries(inputs).map(([k, x]) => [k, x === null ? null : r2(x)]),
    ),
    asOfDate,
    status: finalStatus,
    // Judged here, next to the figure, so every KPI a client receives carries
    // its verdict — see kpi-benchmarks.ts for the thresholds.
    assessment: assessKpi(key, v, finalStatus),
  };
}

/** The figures financial health is computed from — all as of one date. */
export interface HealthInputs {
  cashAndBank: number;
  receivables: number;
  inventory: number;
  currentAssets: number;
  currentLiabilities: number;
  accountsPayable: number;
  totalLiabilities: number;
  totalEquity: number;
  /** Operating revenue over the trailing 90 days. */
  revenue90: number;
  /** Cost of goods sold over the trailing 90 days. */
  cogs90: number;
  /** Average monthly net change in Cash + Bank over the last 3 full months. */
  avgMonthlyNetCash: number;
}

/** Financial-health KPIs from their inputs. Pure: the formulas, nothing else. */
export function healthKpis(i: HealthInputs, asOfDate: string): Kpi[] {
  const dso = divByFlow(i.receivables, i.revenue90);
  const dpo = divByFlow(i.accountsPayable, i.cogs90);
  const dio = divByFlow(i.inventory, i.cogs90);
  const dsoDays = dso === null ? null : dso * 90;
  const dpoDays = dpo === null ? null : dpo * 90;
  const dioDays = dio === null ? null : dio * 90;
  const ccc =
    dsoDays === null || dioDays === null || dpoDays === null
      ? null
      : dsoDays + dioDays - dpoDays;
  const negativeEquity = i.totalEquity <= EPS;
  const burning = i.avgMonthlyNetCash < -EPS;

  return [
    kpi(
      'cashAndBank',
      'Cash and bank',
      'money',
      'Cash + Bank account balances',
      { cashAndBank: i.cashAndBank },
      asOfDate,
      i.cashAndBank,
    ),
    kpi(
      'workingCapital',
      'Working capital',
      'money',
      'Current assets − Current liabilities',
      {
        currentAssets: i.currentAssets,
        currentLiabilities: i.currentLiabilities,
      },
      asOfDate,
      i.currentAssets - i.currentLiabilities,
    ),
    kpi(
      'currentRatio',
      'Current ratio',
      'ratio',
      'Current assets ÷ Current liabilities',
      {
        currentAssets: i.currentAssets,
        currentLiabilities: i.currentLiabilities,
      },
      asOfDate,
      div(i.currentAssets, i.currentLiabilities),
    ),
    kpi(
      'quickRatio',
      'Quick ratio',
      'ratio',
      '(Cash and bank + Receivables) ÷ Current liabilities',
      {
        cashAndBank: i.cashAndBank,
        receivables: i.receivables,
        currentLiabilities: i.currentLiabilities,
      },
      asOfDate,
      div(i.cashAndBank + i.receivables, i.currentLiabilities),
    ),
    kpi(
      'debtToEquity',
      'Debt to equity',
      'ratio',
      'Total liabilities ÷ Total equity',
      { totalLiabilities: i.totalLiabilities, totalEquity: i.totalEquity },
      asOfDate,
      negativeEquity ? null : div(i.totalLiabilities, i.totalEquity),
      negativeEquity ? 'negative_equity' : undefined,
    ),
    kpi(
      'dso',
      'Days sales outstanding',
      'days',
      'Receivables ÷ Operating revenue (trailing 90 days) × 90',
      { receivables: i.receivables, revenue90: i.revenue90 },
      asOfDate,
      dsoDays,
    ),
    kpi(
      'dpo',
      'Days payables outstanding',
      'days',
      'Accounts payable ÷ COGS (trailing 90 days) × 90',
      { accountsPayable: i.accountsPayable, cogs90: i.cogs90 },
      asOfDate,
      dpoDays,
    ),
    kpi(
      'dio',
      'Days inventory outstanding',
      'days',
      'Inventory ÷ COGS (trailing 90 days) × 90',
      { inventory: i.inventory, cogs90: i.cogs90 },
      asOfDate,
      dioDays,
    ),
    kpi(
      'ccc',
      'Cash conversion cycle',
      'days',
      'DSO + DIO − DPO',
      { dso: dsoDays, dio: dioDays, dpo: dpoDays },
      asOfDate,
      ccc,
    ),
    kpi(
      'runwayMonths',
      'Cash runway',
      'months',
      'Cash and bank ÷ average monthly net cash outflow (last 3 full months)',
      { cashAndBank: i.cashAndBank, avgMonthlyNetCash: i.avgMonthlyNetCash },
      asOfDate,
      burning ? Math.max(i.cashAndBank, 0) / -i.avgMonthlyNetCash : null,
      burning ? undefined : 'cash_positive',
    ),
  ];
}

/** A KPI beside its value for the preceding period. */
function compared(current: Kpi, prior: Kpi): ComparedKpi {
  const c = current.value;
  const p = prior.value;
  return {
    ...current,
    current: c,
    prior: p,
    change: c !== null && p !== null ? r2(c - p) : null,
    changePct:
      c !== null && p !== null && Math.abs(p) > EPS
        ? r2(((c - p) / Math.abs(p)) * 100)
        : null,
  };
}

@Injectable()
export class ReportsKpiService {
  constructor(
    private readonly reports: ReportsService,
    private readonly dataSource: DataSource,
    private readonly budgets: BudgetsService,
  ) {}

  // ── Financial health ─────────────────────────────────────────────
  /** The inputs for healthKpis, as of one date. */
  async healthInputs(companyId: string, asOf: string): Promise<HealthInputs> {
    const bs = await this.reports.balanceSheet(companyId, asOf);
    const section = (k: string) => bs.sections.find((s) => s.key === k);
    const subtotal = (k: string) =>
      bs.subtotals.find((x) => x.key === k)?.amount ?? 0;

    const pl = await this.reports.profitLoss(
      companyId,
      addDaysIso(asOf, -89),
      asOf,
    );

    // The three FULL calendar months before the month asOf falls in (D4).
    const monthStart = `${asOf.slice(0, 7)}-01`;
    const windowEnd = dayBefore(monthStart);
    const [y, m] = windowEnd.slice(0, 7).split('-').map(Number);
    const first = new Date(Date.UTC(y, m - 3, 1)).toISOString().slice(0, 10);
    const [cash] = await this.dataSource.query(
      `SELECT COALESCE(SUM(g.debit::numeric - g.credit::numeric), 0) AS v
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id = $1 AND a.sub_type IN ('Cash', 'Bank')
          AND g.date >= $2 AND g.date <= $3`,
      [companyId, first, windowEnd],
    );

    return {
      cashAndBank: section('cashAndBank')?.subtotal ?? 0,
      receivables: section('receivables')?.subtotal ?? 0,
      inventory: section('inventory')?.subtotal ?? 0,
      currentAssets: subtotal('totalCurrentAssets'),
      currentLiabilities: subtotal('totalCurrentLiabilities'),
      accountsPayable: (section('currentLiabilities')?.lines ?? [])
        .filter((l) => l.subType === 'Accounts Payable')
        .reduce((t, l) => t + l.amount, 0),
      totalLiabilities: bs.totalLiabilities,
      totalEquity: bs.totalEquity,
      revenue90: pl.totalIncome,
      cogs90: pl.cogs,
      avgMonthlyNetCash: Number(cash?.v ?? 0) / 3,
    };
  }

  async financialHealth(companyId: string, asOfDate?: string) {
    const asOf = asOfDate || businessToday();
    return {
      asOfDate: asOf,
      kpis: healthKpis(await this.healthInputs(companyId, asOf), asOf),
    };
  }

  /** One health KPI, for reports that show a single figure (aging). */
  async healthKpi(
    companyId: string,
    key: 'dso' | 'dpo',
    asOf: string,
  ): Promise<Kpi> {
    return (await this.financialHealth(companyId, asOf)).kpis.find(
      (k) => k.key === key,
    )!;
  }

  // ── Owner cockpit ────────────────────────────────────────────────
  /**
   * The owner's view of a period beside the one before it.
   *
   * Every money figure comes from the ledger through the statements' own
   * code: the P&L series by profitLoss's rules month by month, operating cash
   * by the counterpart classification, ending cash off the Cash/Bank accounts.
   * Monthly series are zero-filled and apportioned so they add up to the
   * period's statement figure to the paisa. The comparison period is the one
   * of equal length immediately before (whole months for a whole-month range —
   * see precedingPeriod), computed here so no client has to.
   *
   * `salesByCustomer` alone is on the INVOICE basis (subtotal less discount,
   * tax excluded, drafts and voids out), because the ledger does not record
   * revenue by customer; it says so in `basis`.
   */
  async analytics(
    companyId: string,
    startDate?: string,
    endDate?: string,
    opts: { expenseTop?: number; customerTop?: number } = {},
  ) {
    // How many accounts and customers to name before "Other": a donut wants
    // five, a ranked list ten. Bounded so a client cannot ask for a pie of 300.
    const bounded = (n: number | undefined, d: number) =>
      n === undefined || !Number.isFinite(n) ? d : Math.min(10, Math.max(3, Math.trunc(n)));
    const expenseTop = bounded(opts.expenseTop, 8);
    const customerTop = bounded(opts.customerTop, 10);
    const startMonth = await this.reports.fiscalYearStartMonth(companyId);
    const e = endDate || businessToday();
    const s = startDate || fiscalYearStart(startMonth, e);
    const months = monthSpan(s, e);
    if (months > 60) {
      throw new BadRequestException({
        code: 'RANGE_TOO_LONG',
        message: 'Analytics covers at most 60 months; choose a shorter range.',
      });
    }
    const { startDate: ps, endDate: pe } = precedingPeriod(s, e);

    const [
      pl,
      plPrior,
      cf,
      cfPrior,
      byMonth,
      opCash,
      cashTrend,
      healthNow,
      healthPrior,
    ] = await Promise.all([
      this.reports.profitLoss(companyId, s, e),
      this.reports.profitLoss(companyId, ps, pe),
      this.reports.cashFlow(companyId, s, e),
      this.reports.cashFlow(companyId, ps, pe),
      this.reports.pnlByMonth(companyId, s, e),
      this.reports.operatingCashByMonth(companyId, s, e),
      this.reports.cashMonthlyTrend(companyId, s, e, 60),
      this.financialHealth(companyId, e),
      this.financialHealth(companyId, pe),
    ]);

    // ── series ──
    const window = monthWindow(e, months);
    const zero = {
      revenue: 0,
      cogs: 0,
      grossProfit: 0,
      operatingExpenses: 0,
      netIncome: 0,
    };
    const monthRaw = window.map((slot) => byMonth.get(slot.period) ?? zero);
    const fit = (pick: (x: typeof zero) => number, total: number) =>
      apportionRounding(monthRaw.map(pick), total);
    const revenue = fit((x) => x.revenue, pl.revenue);
    const cogs = fit((x) => x.cogs, pl.cogs);
    const grossProfit = fit((x) => x.grossProfit, pl.grossProfit);
    const operatingExpenses = fit((x) => x.operatingExpenses, pl.totalExpenses);
    const netIncome = fit((x) => x.netIncome, pl.netIncome);
    const operatingCashFlow = apportionRounding(
      window.map((slot) => opCash.get(slot.period) ?? 0),
      cf.operating.total,
    );
    const endingByPeriod = new Map(
      cashTrend.map((p) => [p.period, p.endingCash]),
    );
    const series = window.map((slot, i) => ({
      period: slot.period,
      label: slot.label,
      revenue: revenue[i],
      cogs: cogs[i],
      grossProfit: grossProfit[i],
      operatingExpenses: operatingExpenses[i],
      netIncome: netIncome[i],
      operatingCashFlow: operatingCashFlow[i],
      endingCash: endingByPeriod.get(slot.period) ?? null,
    }));

    // ── KPIs, this period against the last ──
    const periodKpis = (p: typeof pl, c: typeof cf, asOf: string) => [
      kpi(
        'revenue',
        'Revenue',
        'money',
        'All revenue (P&L)',
        { revenue: p.revenue },
        asOf,
        p.revenue,
      ),
      kpi(
        'grossProfit',
        'Gross profit',
        'money',
        'Revenue − Cost of goods sold (P&L)',
        { revenue: p.revenue, cogs: p.cogs },
        asOf,
        p.grossProfit,
      ),
      kpi(
        'grossMarginPct',
        'Gross margin',
        'percent',
        'Gross profit ÷ Revenue × 100',
        { grossProfit: p.grossProfit, revenue: p.revenue },
        asOf,
        p.revenue > EPS ? (p.grossProfit / p.revenue) * 100 : null,
      ),
      kpi(
        'netIncome',
        'Net profit',
        'money',
        'Revenue − Cost of goods sold − Expenses (P&L)',
        { grossProfit: p.grossProfit, operatingExpenses: p.totalExpenses },
        asOf,
        p.netIncome,
      ),
      kpi(
        'netMarginPct',
        'Net margin',
        'percent',
        'Net income ÷ Revenue × 100',
        { netIncome: p.netIncome, revenue: p.revenue },
        asOf,
        p.revenue > EPS ? (p.netIncome / p.revenue) * 100 : null,
      ),
      kpi(
        'operatingExpenses',
        'Operating expenses',
        'money',
        'Operating expenses (P&L, excludes COGS and non-operating)',
        { operatingExpenses: p.totalExpenses },
        asOf,
        p.totalExpenses,
      ),
      kpi(
        'operatingCashFlow',
        'Operating cash flow',
        'money',
        'Direct-method operating cash (cash-flow statement)',
        { operatingCashFlow: c.operating.total },
        asOf,
        c.operating.total,
      ),
      kpi(
        'endingCash',
        'Ending cash',
        'money',
        'Cash + Bank at the end of the period',
        { endingCash: c.endingCash },
        asOf,
        c.endingCash,
      ),
    ];
    const pick = (h: { kpis: Kpi[] }, k: string) =>
      h.kpis.find((x) => x.key === k)!;
    const nowKpis = [
      ...periodKpis(pl, cf, e),
      ...['runwayMonths', 'dso', 'dpo', 'dio', 'ccc'].map((k) =>
        pick(healthNow, k),
      ),
    ];
    const priorKpis = [
      ...periodKpis(plPrior, cfPrior, pe),
      ...['runwayMonths', 'dso', 'dpo', 'dio', 'ccc'].map((k) =>
        pick(healthPrior, k),
      ),
    ];
    const kpis: ComparedKpi[] = nowKpis.map((k, i) =>
      compared(k, priorKpis[i]),
    );

    // ── where the money went: top 8 operating expense accounts + Other ──
    const lines = [...pl.expenseLines].sort((a, b) => b.amount - a.amount);
    const top = lines.slice(0, expenseTop);
    const rest = r2(pl.totalExpenses - top.reduce((t, l) => t + l.amount, 0));
    // A share only means something of a positive whole, for a positive part:
    // a credit (a shrinkage gain, a refund) is no slice of what was spent.
    const shareOf = (amount: number) =>
      pl.totalExpenses > EPS && amount >= 0
        ? r2((amount / pl.totalExpenses) * 100)
        : null;
    const expenseByAccount = [
      ...top,
      ...(lines.length > expenseTop
        ? [{ accountCode: '', accountName: 'Other', amount: rest }]
        : []),
    ].map((l) => ({ ...l, sharePct: shareOf(l.amount) }));

    const [salesByCustomer, budgetVsActual] = await Promise.all([
      this.salesByCustomer(companyId, s, e, customerTop),
      this.budgetVsActual(companyId, s, e),
    ]);

    // What stands out — from the figures above and nothing else.
    const budgetRows = (budgetVsActual as { rows?: unknown[] } | null)?.rows;
    const budgetHead = (budgetVsActual as { budget?: { id?: string; fiscalYear?: number } } | null)?.budget;
    const budgetId = budgetHead?.id;
    const insights = buildBusinessInsights({
      range: { startDate: s, endDate: e },
      now: {
        revenue: pl.revenue,
        netIncome: pl.netIncome,
        operatingExpenses: pl.totalExpenses,
        endingCash: cf.endingCash,
      },
      prior: {
        revenue: plPrior.revenue,
        netIncome: plPrior.netIncome,
        operatingExpenses: plPrior.totalExpenses,
        endingCash: cfPrior.endingCash,
      },
      kpis,
      top5SharePct: salesByCustomer.top5SharePct,
      budget:
        budgetVsActual && Array.isArray(budgetRows) && budgetId
          ? {
              id: budgetId,
              fiscalYear: Number(budgetHead?.fiscalYear ?? s.slice(0, 4)),
              rows: (budgetRows as Array<Record<string, unknown>>).map((r) => ({
                accountType: String(r.accountType ?? '').toLowerCase(),
                months: (Array.isArray(r.months) ? r.months : []).map((m: Record<string, unknown>) => ({
                  month: Number(m.month),
                  budgeted: Number(m.budgeted ?? 0),
                  actual: Number(m.actual ?? 0),
                })),
              })),
            }
          : null,
    });

    return {
      range: { startDate: s, endDate: e },
      comparisonRange: { startDate: ps, endDate: pe },
      fiscalYearStart: fiscalYearStart(startMonth, e),
      series,
      kpis,
      expenseByAccount,
      salesByCustomer,
      budgetVsActual,
      health: healthNow,
      insights,
    };
  }

  /** The top customers by invoiced sales (tax excluded) + Other. Invoice basis. */
  private async salesByCustomer(companyId: string, s: string, e: string, topN = 10) {
    const rows = await this.dataSource.query(
      `SELECT i.customer_id AS "customerId", COALESCE(c.name, '') AS name,
              SUM(i.subtotal::numeric - COALESCE(i.discount_amount, 0)::numeric) AS amount,
              COUNT(*)::int AS invoices
         FROM invoices i LEFT JOIN customers c ON c.id = i.customer_id
        WHERE i.company_id = $1 AND i.status NOT IN ('draft', 'void')
          AND i.invoice_date >= $2 AND i.invoice_date <= $3
        GROUP BY i.customer_id, c.name
        ORDER BY amount DESC`,
      [companyId, s, e],
    );
    const all = (rows ?? []).map((r: any) => ({
      customerId: r.customerId,
      name: r.name || '(no customer)',
      raw: Number(r.amount) || 0,
      invoices: Number(r.invoices) || 0,
    }));
    const rawTotal = all.reduce((t: number, x: any) => t + x.raw, 0);
    const top = all.slice(0, topN);
    const rest = all.slice(topN);
    const shareOf = (raw: number) =>
      rawTotal > EPS && raw >= 0 ? r2((raw / rawTotal) * 100) : null;
    const restRaw = rest.reduce((t: number, x: any) => t + x.raw, 0);
    const top5 =
      rawTotal > EPS
        ? r2((all.slice(0, 5).reduce((t: number, x: any) => t + x.raw, 0) / rawTotal) * 100)
        : null;
    return {
      basis: 'invoice' as const,
      label: 'invoice basis',
      note: 'Invoiced sales excluding tax, net of invoice discounts; drafts and voids excluded. Credit memos are not netted.',
      total: r2(rawTotal),
      customers: top.map((x: any) => ({
        customerId: x.customerId,
        name: x.name,
        amount: r2(x.raw),
        invoices: x.invoices,
        sharePct: shareOf(x.raw),
      })),
      other: {
        count: rest.length,
        amount: r2(restRaw),
        sharePct: rest.length ? shareOf(restRaw) : null,
      },
      top5SharePct: top5,
      assessment: assessKpi('top5SharePct', top5),
    };
  }

  /**
   * The active budget for the range, through BudgetsService's own vs-actual.
   * Budgets are kept by CALENDAR year (BudgetsService), so the one chosen is
   * the latest active budget whose year the range touches; null when none is.
   */
  private async budgetVsActual(companyId: string, s: string, e: string) {
    const [budget] = await this.dataSource.query(
      `SELECT b.id FROM budgets b
        WHERE b.company_id = $1 AND b.status = 'active'
          AND b.fiscal_year BETWEEN $2 AND $3
        ORDER BY b.fiscal_year DESC, b.updated_at DESC
        LIMIT 1`,
      [companyId, Number(s.slice(0, 4)), Number(e.slice(0, 4))],
    );
    if (!budget) return null;
    return {
      basis: 'calendarYear' as const,
      ...(await this.budgets.budgetVsActual(companyId, budget.id)),
    };
  }

  // ── Inventory health ─────────────────────────────────────────────
  /**
   * Stock that needs attention, as of a date: what is at or below its reorder
   * point, how long stock has sat since it last arrived and since it last
   * left (D5), what has not moved out in 180 days, how fast stock turns, and
   * where the value sits.
   *
   * Today (no date, or today's date) uses each item's quantity on hand at its
   * average cost — the inventory-valuation figure. A past date uses the dated
   * movement record (Σ quantity_change, Σ value_change), and an item whose
   * record carries an unvalued movement has no value rather than a guessed one.
   */
  async inventoryHealth(companyId: string, asOfDate?: string): Promise<InventoryHealth> {
    const today = businessToday();
    const asOf = asOfDate || today;
    const historic = asOf < today;

    const items = await this.dataSource.query(
      `SELECT it.id AS "itemId", it.name, it.sku,
              it.quantity_on_hand::numeric AS qoh, it.unit_cost::numeric AS cost,
              it.reorder_point::numeric AS "reorderPoint",
              it.reorder_quantity::numeric AS "reorderQuantity",
              COALESCE(l.name, 'Unassigned') AS location,
              it.is_active AS "isActive",
              mv.qty, mv.value, COALESCE(mv.unvalued, 0)::int AS unvalued,
              mv.last_in::text AS "lastIn", mv.last_out::text AS "lastOut"
         FROM inventory_items it
         LEFT JOIN inventory_locations l ON l.id = it.location_id
         LEFT JOIN (
           SELECT m.item_id,
                  SUM(m.quantity_change::numeric) AS qty,
                  SUM(m.value_change::numeric) AS value,
                  COUNT(*) FILTER (WHERE m.value_change IS NULL) AS unvalued,
                  MAX(m.date) FILTER (WHERE ${INBOUND_SQL}) AS last_in,
                  MAX(m.date) FILTER (WHERE ${OUTBOUND_SQL}) AS last_out
             FROM inventory_movements m
            WHERE m.company_id = $1 AND m.date <= $2
            GROUP BY m.item_id
         ) mv ON mv.item_id = it.id
        WHERE it.company_id = $1`,
      [companyId, asOf],
    );

    const stock = (items ?? []).map((r: any) => {
      const qty = historic ? Number(r.qty ?? 0) : Number(r.qoh ?? 0);
      // Today's basis values each item exactly as the inventory-valuation
      // report does — qty × average cost, rounded per item — so the totals tie
      // to it to the paisa. A past date sums the movement record's values.
      const value = historic
        ? Number(r.unvalued) > 0
          ? null
          : Number(r.value ?? 0)
        : r2(qty * Number(r.cost ?? 0));
      return {
        itemId: r.itemId,
        name: r.name,
        sku: r.sku,
        qty,
        value,
        reorderPoint: Number(r.reorderPoint ?? 0),
        reorderQuantity: Number(r.reorderQuantity ?? 0),
        location: r.location,
        isActive: r.isActive !== false,
        lastIn: r.lastIn as string | null,
        lastOut: r.lastOut as string | null,
      };
    });
    const onHand = stock.filter((x: any) => x.qty > EPS);
    const daysSince = (d: string | null) =>
      d ? daysBetweenIso(d, asOf) : null;

    // The item explorer states each item by the same rules (item-stock.ts).
    const suggestion = (x: any) =>
      suggestedOrderQty(x.qty, x.reorderPoint, x.reorderQuantity);
    // A discontinued (inactive) item is never suggested for reordering. Its
    // stock still counts everywhere else — dead stock is exactly where an
    // inactive item with goods left on the shelf belongs.
    const belowReorder = stock
      .filter((x: any) => x.isActive && suggestion(x) !== null)
      .map((x: any) => ({
        itemId: x.itemId,
        name: x.name,
        sku: x.sku,
        qtyOnHand: r2(x.qty),
        reorderPoint: r2(x.reorderPoint),
        reorderQuantity: r2(x.reorderQuantity),
        suggestedOrderQty: suggestion(x),
        stockValue: x.value === null ? null : r2(x.value),
      }))
      .sort(
        (a: any, b: any) =>
          a.qtyOnHand - a.reorderPoint - (b.qtyOnHand - b.reorderPoint),
      );

    const ageBy = (pickDate: (x: any) => string | null) => {
      type AgeKey = (typeof AGE_BUCKETS)[number]['key'] | 'noMovement';
      const buckets = AGE_BUCKETS.map((b) => ({
        key: b.key as AgeKey,
        label: b.label as string,
        count: 0,
        raw: 0,
      }));
      const none = {
        key: 'noMovement' as AgeKey,
        label: 'No movement recorded',
        count: 0,
        raw: 0,
      };
      for (const x of onHand) {
        const d = daysSince(pickDate(x));
        const slot =
          d === null ? none : buckets[AGE_BUCKETS.findIndex((b) => d <= b.max)];
        slot.count++;
        slot.raw += x.value ?? 0;
      }
      return [...buckets, none].map(({ raw, ...b }) => ({
        ...b,
        value: r2(raw),
      }));
    };

    const dead = onHand
      .filter((x: any) => isDeadStock(x.qty, x.lastOut, asOf))
      .map((x: any) => ({
        itemId: x.itemId,
        name: x.name,
        sku: x.sku,
        qtyOnHand: r2(x.qty),
        stockValue: x.value === null ? null : r2(x.value),
        lastOutboundDate: x.lastOut,
        daysSinceOutbound: daysSince(x.lastOut),
      }))
      .sort((a: any, b: any) => (b.stockValue ?? 0) - (a.stockValue ?? 0));

    const byLocation = new Map<string, { value: number; count: number }>();
    for (const x of onHand) {
      const at = byLocation.get(x.location) ?? { value: 0, count: 0 };
      at.value += x.value ?? 0;
      at.count += 1;
      byLocation.set(x.location, at);
    }

    // Turnover over the trailing 12 months: COGS ÷ the average month-end GL
    // 1200 balance — off the ledger, the same figures as the balance sheet.
    const [pl12, closings] = await Promise.all([
      this.reports.profitLoss(companyId, addDaysIso(asOf, -364), asOf),
      this.reports.inventoryClosings(companyId, asOf, 12, true),
    ]);
    const avgInventory =
      closings.reduce((t, p) => t + p.value, 0) / closings.length;
    const turnoverInputs = {
      cogs12: pl12.cogs,
      averageInventory: avgInventory,
    };
    const turnover = kpi(
      'inventoryTurnover',
      'Inventory turnover',
      'ratio',
      'COGS (trailing 12 months) ÷ average month-end inventory (GL 1200, 12 months)',
      turnoverInputs,
      asOf,
      divByFlow(pl12.cogs, avgInventory),
    );
    const dio = kpi(
      'dio12',
      'Days inventory outstanding (12 months)',
      'days',
      'Average month-end inventory ÷ COGS (trailing 12 months) × 365',
      turnoverInputs,
      asOf,
      (() => {
        const d = divByFlow(avgInventory, pl12.cogs);
        return d === null ? null : d * 365;
      })(),
    );

    const valuation = historic
      ? await this.reports.inventoryValuation(companyId, asOf)
      : await this.reports.inventoryValuation(companyId);
    const stockRaw = stock.reduce((t: number, x: any) => t + (x.value ?? 0), 0);
    return {
      asOfDate: asOf,
      basis: historic
        ? ('movementRecord' as const)
        : ('onHandAtAverageCost' as const),
      belowReorder,
      aging: {
        byLastInbound: ageBy((x) => x.lastIn),
        byLastOutbound: ageBy((x) => x.lastOut),
      },
      deadStock: {
        thresholdDays: DEAD_STOCK_DAYS,
        items: dead,
        totalValue: r2(
          dead.reduce((t: number, x: any) => t + (x.stockValue ?? 0), 0),
        ),
      },
      turnover,
      dio,
      byLocation: [...byLocation.entries()]
        .map(([location, v]) => ({ location, value: r2(v.value), count: v.count }))
        .sort((a, b) => b.value - a.value),
      totals: {
        itemCount: stock.length,
        itemsOnHand: onHand.length,
        stockValue: r2(stockRaw),
        valuationTotal: valuation.totalValue,
      },
    };
  }
}
