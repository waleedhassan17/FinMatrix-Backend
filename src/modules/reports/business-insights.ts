import type {
  BusinessInsight,
  ComparedKpi,
  InsightReportKey,
} from './reports.types';

/**
 * What stands out in a period, in plain words.
 *
 * Built ONLY from figures already in the analytics response — the period's
 * P&L and cash against the preceding period, the KPIs and their assessments,
 * customer concentration and the budget — so a sentence can never disagree
 * with the card beside it, and the web and the app show the same text.
 *
 * Most pressing first (negative, warning, positive, neutral), at most six.
 */

const EPS = 0.005;
const MINUS = '−';

/** Rs 406,552 — whole rupees read better in a sentence. */
const rs = (n: number): string => {
  const whole = Math.round(Math.abs(n)).toLocaleString('en-US');
  return `${n < 0 ? MINUS : ''}Rs ${whole}`;
};

/** 10.3% — one decimal, no sign. */
const pct = (n: number): string => `${Math.abs(n).toFixed(1)}%`;

const pctChange = (now: number, then: number): number | null =>
  Math.abs(then) > EPS ? ((now - then) / Math.abs(then)) * 100 : null;

export interface InsightInput {
  range: { startDate: string; endDate: string };
  now: {
    revenue: number;
    netIncome: number;
    operatingExpenses: number;
    endingCash: number;
  };
  prior: {
    revenue: number;
    netIncome: number;
    operatingExpenses: number;
    endingCash: number;
  };
  kpis: ComparedKpi[];
  /** Share of invoiced sales held by the five largest customers. */
  top5SharePct: number | null;
  /**
   * The active budget the range falls in, month by month, so the period is
   * judged against what was budgeted for the same months — not the year.
   */
  budget: {
    id: string;
    fiscalYear: number;
    rows: Array<{
      accountType: string;
      months: Array<{ month: number; budgeted: number; actual: number }>;
    }>;
  } | null;
}

const TONE_ORDER: Record<BusinessInsight['tone'], number> = {
  negative: 0,
  warning: 1,
  positive: 2,
  neutral: 3,
};

export function buildBusinessInsights(input: InsightInput): BusinessInsight[] {
  const { range, now, prior, kpis } = input;
  const period = { startDate: range.startDate, endDate: range.endDate };
  const link = (
    key: InsightReportKey,
    params: Record<string, string> = period,
  ) => ({ key, params });
  const kpi = (key: string) => kpis.find((k) => k.key === key);
  const out: BusinessInsight[] = [];

  // ── Revenue against the previous period ────────────────────────────
  const revChange = pctChange(now.revenue, prior.revenue);
  if (now.revenue <= EPS && prior.revenue <= EPS) {
    out.push({
      key: 'revenue',
      tone: 'warning',
      title: 'No revenue recorded',
      detail: 'Nothing was posted to revenue in this period or the one before.',
      report: link('profitLoss'),
    });
  } else if (revChange === null) {
    out.push({
      key: 'revenue',
      tone: 'neutral',
      title: `${rs(now.revenue)} of revenue`,
      detail: 'There is no revenue in the previous period to compare with.',
      report: link('profitLoss'),
    });
  } else if (revChange >= 5) {
    out.push({
      key: 'revenue',
      tone: 'positive',
      title: `Revenue up ${pct(revChange)}`,
      detail: `${rs(now.revenue)} this period, against ${rs(prior.revenue)} in the previous one.`,
      report: link('profitLoss'),
    });
  } else if (revChange <= -5) {
    out.push({
      key: 'revenue',
      tone: revChange <= -20 ? 'negative' : 'warning',
      title: `Revenue down ${pct(revChange)}`,
      detail: `${rs(now.revenue)} this period, against ${rs(prior.revenue)} in the previous one.`,
      report: link('profitLoss'),
    });
  } else {
    out.push({
      key: 'revenue',
      tone: 'neutral',
      title: 'Revenue holding steady',
      detail: `${rs(now.revenue)} this period, within 5% of the previous one.`,
      report: link('profitLoss'),
    });
  }

  // ── Profit: a loss first; otherwise how the margin moved ──────────
  if (now.netIncome < -EPS) {
    out.push({
      key: 'netLoss',
      tone: 'negative',
      title: `Net loss of ${rs(Math.abs(now.netIncome))}`,
      detail: 'Cost of sales and expenses were more than revenue this period.',
      report: link('profitLoss'),
    });
  } else {
    const gm = kpi('grossMarginPct');
    if (
      gm &&
      gm.current !== null &&
      gm.prior !== null &&
      Math.abs(gm.current - gm.prior) >= 2
    ) {
      const up = gm.current > gm.prior;
      out.push({
        key: 'grossMargin',
        tone: up ? 'positive' : 'warning',
        title: `Gross margin ${up ? 'improved' : 'slipped'} to ${pct(gm.current)}`,
        detail: `${up ? 'Up' : 'Down'} ${Math.abs(gm.current - gm.prior).toFixed(1)} points on the previous period.`,
        report: link('profitLoss'),
      });
    } else if (gm && gm.current !== null && now.netIncome > EPS) {
      const nm = kpi('netMarginPct');
      out.push({
        key: 'margins',
        tone: 'neutral',
        title: `Keeping ${pct(nm?.current ?? 0)} of revenue as profit`,
        detail: `Gross margin ${pct(gm.current)}; net profit ${rs(now.netIncome)}.`,
        report: link('profitLoss'),
      });
    }
  }

  // ── Cash: runway, then the move in cash ────────────────────────────
  const runway = kpi('runwayMonths');
  if (now.endingCash < -EPS) {
    out.push({
      key: 'overdrawn',
      tone: 'negative',
      title: 'Cash and bank are overdrawn',
      detail: `The accounts end the period at ${rs(now.endingCash)}.`,
      report: link('cashFlow'),
    });
  } else if (
    runway &&
    runway.current !== null &&
    runway.assessment.level !== 'healthy'
  ) {
    out.push({
      key: 'runway',
      tone: runway.assessment.level === 'risk' ? 'negative' : 'warning',
      title: `Cash covers about ${runway.current.toFixed(1)} months`,
      detail: `At the average outflow of the last three full months, ${rs(now.endingCash)} lasts about ${runway.current.toFixed(1)} months.`,
      report: link('cashFlow'),
    });
  } else {
    const cashChange = pctChange(now.endingCash, prior.endingCash);
    if (cashChange !== null && cashChange <= -20) {
      out.push({
        key: 'cash',
        tone: 'warning',
        title: `Cash down ${pct(cashChange)}`,
        detail: `${rs(now.endingCash)} at the end of the period, from ${rs(prior.endingCash)}.`,
        report: link('cashFlow'),
      });
    } else if (cashChange !== null && cashChange >= 20) {
      out.push({
        key: 'cash',
        tone: 'positive',
        title: `Cash up ${pct(cashChange)}`,
        detail: `${rs(now.endingCash)} at the end of the period, from ${rs(prior.endingCash)}.`,
        report: link('cashFlow'),
      });
    }
  }

  // ── Collections ────────────────────────────────────────────────────
  const dso = kpi('dso');
  if (
    dso &&
    dso.current !== null &&
    (dso.assessment.level === 'watch' || dso.assessment.level === 'risk')
  ) {
    out.push({
      key: 'collections',
      tone: dso.assessment.level === 'risk' ? 'negative' : 'warning',
      title: `Customers take ${Math.round(dso.current)} days to pay`,
      detail:
        'Receivables against the last 90 days of sales. The aging report shows who to chase first.',
      report: link('arAging', {}),
    });
  }

  // ── Customer concentration ─────────────────────────────────────────
  if (input.top5SharePct !== null && input.top5SharePct > 50) {
    out.push({
      key: 'concentration',
      tone: input.top5SharePct > 70 ? 'negative' : 'warning',
      title: `Top 5 customers are ${pct(input.top5SharePct)} of sales`,
      detail:
        'Losing any one of them would be felt; a wider customer base spreads the risk.',
      report: link('arAging', {}),
    });
  }

  // ── Running costs ──────────────────────────────────────────────────
  const opexChange = pctChange(now.operatingExpenses, prior.operatingExpenses);
  if (
    opexChange !== null &&
    opexChange >= 15 &&
    prior.operatingExpenses > EPS
  ) {
    out.push({
      key: 'opex',
      tone: 'warning',
      title: `Operating expenses up ${pct(opexChange)}`,
      detail: `${rs(now.operatingExpenses)} this period, against ${rs(prior.operatingExpenses)} in the previous one.`,
      report: link('profitLoss'),
    });
  }

  // ── Budget: the range's months against the same months' budget ─────
  if (input.budget) {
    const { fiscalYear } = input.budget;
    const covered = (month: number) => {
      const first = `${fiscalYear}-${String(month).padStart(2, '0')}-01`;
      const last = `${fiscalYear}-${String(month).padStart(2, '0')}-31`;
      return first <= range.endDate && last >= range.startDate;
    };
    const sum = (types: string[], f: 'budgeted' | 'actual') =>
      input
        .budget!.rows.filter((r) => types.includes(r.accountType))
        .reduce(
          (t, r) =>
            t +
            r.months
              .filter((m) => covered(m.month))
              .reduce((u, m) => u + (Number(m[f]) || 0), 0),
          0,
        );
    const budgetLink = {
      key: 'budgets' as const,
      params: { budgetId: input.budget.id },
    };

    const spent = sum(['expense'], 'actual');
    const allowed = sum(['expense'], 'budgeted');
    const over = allowed > EPS ? pctChange(spent, allowed) : null;
    if (over !== null && over > 5) {
      out.push({
        key: 'budget',
        tone: over > 15 ? 'negative' : 'warning',
        title: `Spending ${pct(over)} over budget`,
        detail: `${rs(spent)} spent against ${rs(allowed)} budgeted for the same months.`,
        report: budgetLink,
      });
    } else if (over !== null) {
      out.push({
        key: 'budget',
        tone: 'positive',
        title: 'Spending within budget',
        detail: `${rs(spent)} spent against ${rs(allowed)} budgeted for the same months.`,
        report: budgetLink,
      });
    }

    const sold = sum(['revenue', 'income'], 'actual');
    const target = sum(['revenue', 'income'], 'budgeted');
    const behind = target > EPS ? pctChange(sold, target) : null;
    if (behind !== null && behind <= -10) {
      out.push({
        key: 'revenueBudget',
        tone: 'warning',
        title: `Revenue ${pct(behind)} behind budget`,
        detail: `${rs(sold)} against ${rs(target)} budgeted for the same months.`,
        report: budgetLink,
      });
    }
  }

  return out
    .map((x, i) => ({ x, i }))
    .sort((a, b) => TONE_ORDER[a.x.tone] - TONE_ORDER[b.x.tone] || a.i - b.i)
    .slice(0, 6)
    .map(({ x }) => x);
}
