/**
 * Response shapes for the financial statements.
 *
 * Every field the API already returned keeps its name AND its type here: the
 * P&L screen reads `cogs`/`expenses` as numbers and the CSV export flattens the
 * whole object into one row, so those two stay scalar. The per-account detail
 * added alongside them is therefore named `cogsLines`/`expenseLines`.
 *
 * Fields marked "v2" are additive: a client built before them reads every
 * response exactly as it did. None of them is ever named `data` or `success`
 * — ResponseEnvelopeInterceptor treats both keys specially.
 */
import type { CashFlowLineKey, CashFlowSectionKey } from './cash-flow-classify';
import type { AccountGroupKey, StatementGroupKey } from './statement-groups';

export type { CashFlowLineKey, CashFlowSectionKey, AccountGroupKey, StatementGroupKey };

/** One account's contribution to a statement section, sign already applied. */
export interface PnlLine {
  accountCode: string;
  accountName: string;
  amount: number;
}

export interface ProfitLossReport {
  range: { startDate: string; endDate: string };
  comparisonRange: null;

  // ── Existing fields — unchanged name, type and value ──
  /** All revenue, including non-operating. */
  revenue: number;
  /** Total cost of goods sold. */
  cogs: number;
  grossProfit: number;
  /** ALL non-COGS expense, including non-operating. Differs from
   *  `totalExpenses` once a non-operating account exists — that is the split
   *  doing its job, not a discrepancy. */
  expenses: number;
  netIncome: number;

  // ── Added: per-account detail and the operating / non-operating split ──
  income: PnlLine[];
  cogsLines: PnlLine[];
  expenseLines: PnlLine[];
  /** 7xxx, and revenue accounts with subtype 'Other Revenue' or 'Interest'. */
  otherIncome: PnlLine[];
  /** 8xxx, and expense accounts with subtype 'Other Expense'. */
  otherExpense: PnlLine[];

  /** Operating revenue only (excludes otherIncome). */
  totalIncome: number;
  totalCogs: number;
  /** Operating expense only (excludes otherExpense). */
  totalExpenses: number;
  netOperatingIncome: number;
  netOtherIncome: number;
}

// ── Balance sheet ────────────────────────────────────────────────────

/**
 * A balance-sheet line. Equity may carry two kinds of derived line:
 *  - the Retained Earnings ACCOUNT line, whose amount is its posted balance
 *    plus every earlier fiscal year's net income (`composite` says how much
 *    of each), and
 *  - SYNTHETIC lines with accountCode '' — 'retainedEarnings' when the chart
 *    has no Retained Earnings account, and 'currentYearEarnings', the net
 *    income from the start of the current fiscal year to asOfDate.
 */
export interface BalanceSheetLine {
  accountCode: string;
  accountName: string;
  amount: number;
  /** v2 — set only on a derived equity line that is not a real account. */
  synthetic?: 'retainedEarnings' | 'currentYearEarnings';
  /** v2 — set only on the Retained Earnings account's line. */
  composite?: { postedBalance: number; priorYearsEarnings: number };
}

/** v2 — one line inside a balance-sheet section. */
export interface BalanceSheetSectionLine extends BalanceSheetLine {
  subType: string | null;
  /** Null without `compareTo`. */
  priorAmount: number | null;
  change: number | null;
  /** Null without `compareTo`, and when the prior amount is zero. */
  changePct: number | null;
  /** Null when total assets are zero. */
  pctOfTotalAssets: number | null;
}

/** v2 — a balance-sheet section, grouped by classifyForStatement. */
export interface BalanceSheetSection {
  key: StatementGroupKey;
  label: string;
  lines: BalanceSheetSectionLine[];
  subtotal: number;
  priorSubtotal: number | null;
  /** Null without `compareTo`. */
  change: number | null;
  /** Null without `compareTo`, and when the prior subtotal is zero. */
  changePct: number | null;
  /** Null when total assets are zero. */
  subtotalPctOfTotalAssets: number | null;
}

/** v2 — the statement's subtotals, each footed from raw figures. */
export interface BalanceSheetSubtotal {
  key:
    | 'totalCurrentAssets'
    | 'totalAssets'
    | 'totalCurrentLiabilities'
    | 'totalLiabilities'
    | 'totalEquity'
    | 'totalLiabilitiesAndEquity'
    | string;
  label: string;
  amount: number;
  priorAmount: number | null;
  change: number | null;
  changePct: number | null;
  pctOfTotalAssets: number | null;
}

export interface BalanceSheetReport {
  asOfDate: string;
  assets: BalanceSheetLine[];
  liabilities: BalanceSheetLine[];
  equity: BalanceSheetLine[];
  totalAssets: number;
  totalLiabilities: number;
  totalEquity: number;
  isBalanced: boolean;
  // ── v2 ──
  /** First day of the fiscal year asOfDate falls in. */
  fiscalYearStart: string;
  totalLiabilitiesAndEquity: number;
  /** Assets − (Liabilities + Equity), raw then rounded. 0 when balanced. */
  gap: number;
  sections: BalanceSheetSection[];
  subtotals: BalanceSheetSubtotal[];
  /** Present only with `compareTo`. */
  comparison: {
    asOfDate: string;
    totalAssets: number;
    totalLiabilities: number;
    totalEquity: number;
  } | null;
}

// ── Cash flow ────────────────────────────────────────────────────────

export interface CashFlowLine {
  label: string;
  amount: number;
  /** v2 — stable key for the line; open its rows at
   *  /reports/cash-flow/lines/:lineKey/entries. */
  lineKey?: CashFlowLineKey;
  /** v2 */
  section?: CashFlowSectionKey;
}

export interface CashFlowSection {
  lines: CashFlowLine[];
  total: number;
}

/**
 * Indirect operating reconciliation — net income adjusted for non-cash items
 * and working-capital movement. `total` always equals the direct method's
 * `operating.total`; anything the named adjustments cannot account for is
 * carried by an explicit "Other operating adjustments" line rather than being
 * quietly absorbed.
 */
export interface OperatingIndirect {
  netIncome: number;
  adjustments: CashFlowLine[];
  total: number;
  /**
   * v2 — non-cash transactions kept OUT of the working-capital lines
   * (IAS 7.43), with the effect each would otherwise have had on the walk.
   */
  excludedNonCash?: CashFlowLine[];
}

/** v2 — one cash or bank account across the range. */
export interface CashFlowAccount {
  accountCode: string;
  accountName: string;
  beginning: number;
  ending: number;
}

export interface CashFlowReport {
  range: { startDate: string; endDate: string };
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netChange: number;
  beginningCash: number;
  endingCash: number;
  /** Zero-filled; at most the last 12 months of the range. */
  monthlyTrend: Array<{
    label: string;
    /** Net cash movement in the month (within the range). */
    value: number;
    /** v2 — Cash + Bank held at the month's end. */
    endingCash?: number;
  }>;
  operatingIndirect?: OperatingIndirect;
  /** v2 — Σ ending = endingCash. */
  accounts?: CashFlowAccount[];
  /** v2 — the tie to the balance sheet's Cash + Bank at endDate. */
  cashTie?: { endingCash: number; balanceSheetCash: number; ties: boolean };
  /**
   * v2 — cash in and cash out by month, over the same months as
   * `monthlyTrend`. Transfers between the company's own cash and bank
   * accounts are in neither column; `inflow − outflow = net`, and Σ net over a
   * range that fits the window = `netChange`.
   */
  monthly?: CashFlowMonth[];
}

/** v2 — one month of `cash-flow` `monthly[]`. */
export interface CashFlowMonth {
  /** 'YYYY-MM' */
  period: string;
  label: string;
  inflow: number;
  outflow: number;
  net: number;
  /** Cash + Bank held at the month's end. */
  endingCash: number;
}

// ── Trial balance ────────────────────────────────────────────────────

/**
 * v2 — `mode` on /reports/trial-balance. Absent, the response is the
 * period-movement trial balance exactly as before.
 */
export type TrialBalanceMode = 'movement' | 'closing' | 'working';

export type TrialBalanceFlag = 'abnormal_balance' | 'contra_assumed' | 'obe_nonzero';

// ── KPIs ─────────────────────────────────────────────────────────────

/** How a KPI's value is expressed. */
export type KpiUnit = 'money' | 'ratio' | 'days' | 'months' | 'percent';

/**
 * Why a KPI has the value it has. Anything but 'ok' means `value` is null:
 *  - no_denominator: the figure it divides by is zero (no revenue, no COGS…);
 *  - negative_equity: debt-to-equity is meaningless when equity ≤ 0;
 *  - cash_positive: runway is unbounded while cash is not falling.
 */
export type KpiStatus = 'ok' | 'no_denominator' | 'negative_equity' | 'cash_positive';

/**
 * How a figure reads against a rule of thumb — see kpi-benchmarks.ts, the one
 * place the thresholds live. `neutral` when there is no benchmark for it, or
 * nothing to judge yet. Clients show `level` as a pill and quote `guide`.
 */
export type KpiAssessmentLevel = 'healthy' | 'watch' | 'risk' | 'neutral';

export interface KpiAssessment {
  level: KpiAssessmentLevel;
  /** One sentence: what good looks like for this figure. */
  guide: string;
}

/**
 * One KPI, computed on the server so every client shows the same figure.
 * `value` is null — never Infinity or NaN — whenever `status` is not 'ok'.
 * `inputs` are the figures the formula used, so a reader can check it.
 */
export interface Kpi {
  key: string;
  label: string;
  value: number | null;
  unit: KpiUnit;
  formula: string;
  inputs: Record<string, number | null>;
  asOfDate: string;
  status: KpiStatus;
  /** v2 — the value against its benchmark. */
  assessment: KpiAssessment;
}

/** A KPI over a period, beside the same KPI for the preceding period. */
export interface ComparedKpi extends Kpi {
  current: number | null;
  prior: number | null;
  change: number | null;
  /** Null when the prior value is zero or null. */
  changePct: number | null;
}

// ── Drill-downs (v2) ─────────────────────────────────────────────────

/** One general_ledger row as every drill-down returns it. */
export interface LedgerEntry {
  id: string;
  date: string;
  /** The journal-entry number (JE-…). */
  reference: string;
  memo: string | null;
  debit: number;
  credit: number;
  /** Signed by the account's normal balance — entries add up to the line. */
  amount: number;
  sourceType: string;
  sourceId: string;
  sourceLabel: string;
  /** The document's own number (INV-…, BILL-…), else the JE reference. */
  documentNumber: string | null;
  counterpartyName: string | null;
}

/** GET /reports/accounts/:accountCode/register */
export interface AccountRegister {
  account: { accountCode: string; accountName: string; accountType: string; subType: string | null };
  range: { startDate: string; endDate: string };
  /** 'cumulative' for balance-sheet accounts; 'fiscalYearToDate' for P&L. */
  openingBasis: 'cumulative' | 'fiscalYearToDate';
  openingBalance: number;
  periodDebit: number;
  periodCredit: number;
  /** The period's movement, signed like the entries. */
  periodNet: number;
  closingBalance: number;
  entries: Array<LedgerEntry & { runningBalance: number }>;
  total: number;
  page: number;
  limit: number;
  order: 'asc' | 'desc';
}

/** GET /reports/accounts/:accountCode/movement */
export interface AccountMovement {
  account: { accountCode: string; accountName: string; accountType: string; subType: string | null };
  range: { startDate: string; endDate: string };
  compareRange: { startDate: string; endDate: string };
  current: number;
  prior: number;
  /** current − prior as displayed. */
  change: number;
  changePct: number | null;
  /** Sorted by |change|; 'Unattributed' = no counterparty; 'Other' = beyond limit. Σ change = change. */
  byCounterparty: Array<{ name: string; current: number; prior: number; change: number }>;
  /** Σ change = change. */
  bySourceType: Array<{ sourceLabel: string; current: number; prior: number; change: number }>;
}

/** GET /reports/balance-sheet/retained-earnings */
export interface RetainedEarningsBreakdown {
  asOfDate: string;
  fiscalYearStart: string;
  retainedEarningsAccount: { accountCode: string; accountName: string } | null;
  /** Posted directly to the Retained Earnings account (0 when there is none). */
  postedTo3100: number;
  priorYearsEarnings: number;
  byFiscalYear: Array<{ fiscalYear: number; startDate: string; endDate: string; netIncome: number }>;
  /** Equals the balance sheet's Retained Earnings line exactly. */
  total: number;
}

/** GET /reports/cash-flow/lines/:lineKey/entries */
export interface CashFlowLineEntries {
  lineKey: CashFlowLineKey;
  label: string;
  section: CashFlowSectionKey;
  range: { startDate: string; endDate: string };
  lineAmount: number;
  /** Cash rows, newest first. `amount` is debit-positive cash. Σ allocatedAmount = lineAmount. */
  entries: Array<LedgerEntry & {
    cashAccountCode: string;
    cashAccountName: string | null;
    allocatedAmount: number;
    /** 0–100. Below 100 when the posting's cash was split across lines. */
    allocationPct: number;
  }>;
  total: number;
  page: number;
  limit: number;
}

/** A trial-balance row with an explicit `mode`. */
export interface TrialBalanceRowV2 {
  accountCode: string;
  accountName: string;
  debit: number;
  credit: number;
  accountType: string;
  subType: string | null;
  group: AccountGroupKey;
  flags: TrialBalanceFlag[];
  /** The "Retained earnings — prior years' net income" row (closing/working). */
  synthetic?: true;
  // mode=working only:
  openingDebit?: number;
  openingCredit?: number;
  periodDebit?: number;
  periodCredit?: number;
  closingDebit?: number;
  closingCredit?: number;
}

/** GET /reports/trial-balance?mode=… */
export interface TrialBalanceV2 {
  range: { startDate: string; endDate: string };
  mode: TrialBalanceMode;
  /** mode=closing */
  asOfDate?: string;
  /** mode=closing: FY of endDate; mode=working: FY of startDate. */
  fiscalYearStart?: string;
  rows: TrialBalanceRowV2[];
  /** working: the closing columns. */
  totalDebits: number;
  totalCredits: number;
  /** working: every column pair balances. */
  isBalanced: boolean;
  groups: Array<{
    key: AccountGroupKey;
    label: string;
    debit: number;
    credit: number;
    openingDebit?: number;
    openingCredit?: number;
    periodDebit?: number;
    periodCredit?: number;
    closingDebit?: number;
    closingCredit?: number;
  }>;
  /** mode=working */
  balanced?: { opening: boolean; period: boolean; closing: boolean };
  totals?: {
    openingDebit: number; openingCredit: number;
    periodDebit: number; periodCredit: number;
    closingDebit: number; closingCredit: number;
  };
  warnings?: Array<{ code: 'CROSSES_FISCAL_YEAR' | string; message: string }>;
}

// ── Insights (v2) ────────────────────────────────────────────────────

/** GET /reports/financial-health */
export interface FinancialHealth {
  asOfDate: string;
  /** Keys: cashAndBank, workingCapital, currentRatio, quickRatio, debtToEquity,
   *  dso, dpo, dio, ccc, runwayMonths. */
  kpis: Kpi[];
}

/** GET /reports/analytics */
export interface OwnerAnalytics {
  range: { startDate: string; endDate: string };
  comparisonRange: { startDate: string; endDate: string };
  fiscalYearStart: string;
  /** Every month of the range, zero-filled. Σ of each P&L series = the P&L. */
  series: Array<{
    period: string;
    label: string;
    revenue: number;
    cogs: number;
    grossProfit: number;
    operatingExpenses: number;
    netIncome: number;
    operatingCashFlow: number;
    endingCash: number | null;
  }>;
  /** revenue, grossProfit, grossMarginPct, netIncome, netMarginPct,
   *  operatingExpenses, operatingCashFlow, endingCash, runwayMonths, dso, dpo,
   *  dio, ccc. */
  kpis: ComparedKpi[];
  /**
   * The top `expenseTop` (default 8) operating expense accounts + 'Other';
   * Σ = operatingExpenses. `sharePct` (v2) is each line's share of that total,
   * null when the total is not positive or the line is a credit.
   */
  expenseByAccount: Array<PnlLine & { sharePct: number | null }>;
  salesByCustomer: {
    basis: 'invoice';
    label: 'invoice basis';
    note: string;
    total: number;
    /** `sharePct` (v2): each customer's share of `total`. */
    customers: Array<{
      customerId: string | null;
      name: string;
      amount: number;
      invoices: number;
      sharePct: number | null;
    }>;
    other: { count: number; amount: number; sharePct: number | null };
    top5SharePct: number | null;
    /** v2 — top5SharePct against its benchmark. */
    assessment: KpiAssessment;
  };
  /** BudgetsService.budgetVsActual for the active budget the range touches. */
  budgetVsActual: ({ basis: 'calendarYear' } & Record<string, unknown>) | null;
  health: FinancialHealth;
  /** v2 — what stands out in the period, most pressing first (1–6). */
  insights: BusinessInsight[];
}

/** The report a client opens for an insight, by key — each client maps it to its own route. */
export type InsightReportKey =
  | 'profitLoss'
  | 'balanceSheet'
  | 'cashFlow'
  | 'arAging'
  | 'apAging'
  | 'inventoryValuation'
  | 'budgets';

/**
 * One plain-language observation about the period, built only from the
 * figures in the same response, so the web and the app say the same thing.
 */
export interface BusinessInsight {
  key: string;
  tone: 'positive' | 'neutral' | 'warning' | 'negative';
  title: string;
  detail: string;
  report: { key: InsightReportKey; params: Record<string, string> };
}

/** `insights` on ar-aging / ap-aging JSON. */
export interface AgingInsights {
  /** ar-aging */
  dso?: Kpi;
  /** ap-aging */
  dpo?: Kpi;
  /** = totals.total */
  totalOpen: number;
  overdue: number;
  overduePct: number | null;
  /** Balance-weighted, over overdue documents; null when nothing is overdue. */
  weightedAvgDaysOverdue: number | null;
  top5SharePct: number | null;
  /** v2 — each ratio above against its benchmark. */
  assessments: {
    overduePct: KpiAssessment;
    weightedAvgDaysOverdue: KpiAssessment;
    top5SharePct: KpiAssessment;
  };
  /** By due date from today; Σ amount = totalOpen. */
  schedule: Array<{
    key: 'overdue' | 'd0_7' | 'd8_14' | 'd15_30' | 'd31_60' | 'd60_plus';
    label: string;
    amount: number;
    count: number;
  }>;
}

/** Fields added to each ar-aging / ap-aging row (JSON only). */
export interface AgingRowV2 {
  paymentTerms: string | null;
  /** ar-aging only. 0 = no limit. */
  creditLimit?: number;
  overLimit?: boolean;
  /** total ÷ creditLimit × 100; null with no limit. */
  creditUsedPct?: number | null;
  lastPaymentDate: string | null;
  lastPaymentAmount: number | null;
  oldestDueDate: string | null;
}

/** GET /reports/inventory-health */
export interface InventoryHealth {
  asOfDate: string;
  basis: 'onHandAtAverageCost' | 'movementRecord';
  belowReorder: Array<{
    itemId: string; name: string; sku: string;
    qtyOnHand: number; reorderPoint: number; reorderQuantity: number;
    /** max(reorderQuantity, reorderPoint − qtyOnHand) */
    suggestedOrderQty: number;
    stockValue: number | null;
  }>;
  aging: {
    byLastInbound: Array<{ key: 'd0_30' | 'd31_90' | 'd91_180' | 'd180_plus' | 'noMovement'; label: string; count: number; value: number }>;
    byLastOutbound: Array<{ key: 'd0_30' | 'd31_90' | 'd91_180' | 'd180_plus' | 'noMovement'; label: string; count: number; value: number }>;
  };
  deadStock: {
    thresholdDays: 180;
    items: Array<{
      itemId: string; name: string; sku: string; qtyOnHand: number; stockValue: number | null;
      lastOutboundDate: string | null; daysSinceOutbound: number | null;
    }>;
    totalValue: number;
  };
  /** key 'inventoryTurnover' */
  turnover: Kpi;
  /** key 'dio12' */
  dio: Kpi;
  /** Items on hand and their value, per location ('Unassigned' when none). */
  byLocation: Array<{ location: string; value: number; count: number }>;
  totals: { itemCount: number; itemsOnHand: number; stockValue: number; valuationTotal: number };
}

/** GET /reports/inventory-valuation?asOfDate=… (absent: the old shape). */
export interface InventoryValuationAsOf {
  asOfDate: string;
  rows: Array<{
    itemId: string; itemName: string; sku: string; category: string;
    qty: number; cost: number | null; value: number | null; valueKnown: boolean;
  }>;
  byCategory: Array<{ category: string; totalValue: number }>;
  totalValue: number;
  coverage: { movements: number; valued: number; pct: number; unvaluedItems: number };
  ledgerTie: { gl1200: number; valuation: number; gap: number; includesGoodsInTransit: false };
}
