/**
 * Response shapes for the financial statements.
 *
 * Every field the API already returned keeps its name AND its type here: the
 * P&L screen reads `cogs`/`expenses` as numbers and the CSV export flattens the
 * whole object into one row, so those two stay scalar. The per-account detail
 * added alongside them is therefore named `cogsLines`/`expenseLines`.
 */

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
   *  `totalExpenses` once a 7xxx/8xxx account exists — that is the split
   *  doing its job, not a discrepancy. */
  expenses: number;
  netIncome: number;

  // ── Added: per-account detail and the operating / non-operating split ──
  income: PnlLine[];
  cogsLines: PnlLine[];
  expenseLines: PnlLine[];
  otherIncome: PnlLine[];
  otherExpense: PnlLine[];

  /** Operating revenue only (excludes otherIncome). */
  totalIncome: number;
  totalCogs: number;
  /** Operating expense only (excludes otherExpense). */
  totalExpenses: number;
  netOperatingIncome: number;
  netOtherIncome: number;
}

export interface CashFlowLine {
  label: string;
  amount: number;
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
}

export interface CashFlowReport {
  range: { startDate: string; endDate: string };
  operating: CashFlowSection;
  investing: CashFlowSection;
  financing: CashFlowSection;
  netChange: number;
  beginningCash: number;
  endingCash: number;
  monthlyTrend: Array<{ label: string; value: number }>;
  operatingIndirect?: OperatingIndirect;
}
