import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Invoice } from '../invoices/entities/invoice.entity';
import { Bill } from '../bills/entities/bill.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { TaxPayment } from '../tax/entities/tax-payment.entity';
import type {
  CashFlowLine,
  CashFlowReport,
  OperatingIndirect,
  PnlLine,
  ProfitLossReport,
} from './reports.types';
import {
  AgingBucketSpecError,
  LEGACY_BOUNDARIES,
  bucketKeyFor,
  buildBucketSpec,
  resolveAgingSpec,
  type AgingSpecRequest,
  type ResolvedAgingSpec,
} from './aging-buckets';
import { businessToday, daysBetweenIso } from '../../common/utils/business-date.util';

const r2 = (n: number) => Math.round(n * 100) / 100;

/** How many customers the item explorer names before folding the rest. */
const TOP_CUSTOMERS = 5;
const num = (v: any) => parseFloat(v ?? '0') || 0;

/**
 * What "open" means for aging, in one place.
 *
 * `balance > 0` alone is not enough and `status` alone is not enough: a draft is
 * not owed to anybody yet, and a voided document never was. Both aging queries
 * and both drill-downs read this, so the summary and the detail beneath it
 * cannot come to different conclusions about which documents exist.
 *
 * That is not hypothetical. `InvoicesService.outstandingForCustomer` answers
 * almost the same question with `status NOT IN ('draft','void')` — no `paid` —
 * and reusing it here would have made a party's documents disagree with the row
 * they were opened from. Aging totals also tie to GL 1100/2000 in four
 * acceptance suites, so this predicate is load-bearing beyond these reports:
 * change it and those ties move.
 *
 * @param alias the table alias in the caller's query (`i` invoices, `b` bills)
 */
const openDocPredicate = (alias: string) =>
  `${alias}.balance::numeric > 0 AND ${alias}.status NOT IN ('paid','void','draft')`;

const MONTH_LABELS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** 'Jan 26' — the label shape every trend series in this file already uses. */
const monthLabel = (yr: number, mo: number) =>
  `${MONTH_LABELS[mo - 1]} ${String(yr).slice(2)}`;

interface MonthSlot {
  /** Sort/join key, 'YYYY-MM'. */
  period: string;
  label: string;
  /** Last calendar day of the month, for an as-of cut. */
  endDate: string;
}

/**
 * The last `count` calendar months ending with the month containing `endIso`.
 *
 * Built from the calendar rather than from the data so a series has a fixed
 * width: a chart whose bar count depends on how much history a company happens
 * to have re-scales every time a month is added, and an item with one month of
 * movements renders as a single bar filling the frame.
 */
function monthWindow(endIso: string, count: number): MonthSlot[] {
  const [y, m] = endIso.slice(0, 7).split('-').map(Number);
  return Array.from({ length: count }, (_, i) => {
    const offset = count - 1 - i;
    const d = new Date(Date.UTC(y, m - 1 - offset, 1));
    const yr = d.getUTCFullYear();
    const mo = d.getUTCMonth() + 1;
    // Day 0 of the NEXT month is the last day of this one, leap years included.
    const last = new Date(Date.UTC(yr, mo, 0)).getUTCDate();
    return {
      period: `${yr}-${String(mo).padStart(2, '0')}`,
      label: monthLabel(yr, mo),
      endDate: `${yr}-${String(mo).padStart(2, '0')}-${String(last).padStart(2, '0')}`,
    };
  });
}

/** Whole months from one ISO date to another, inclusive of both ends. */
function monthSpan(startIso: string, endIso: string): number {
  const [sy, sm] = startIso.slice(0, 7).split('-').map(Number);
  const [ey, em] = endIso.slice(0, 7).split('-').map(Number);
  return (ey - sy) * 12 + (em - sm) + 1;
}

/**
 * What to call the document behind a ledger row, for the statement drill-down.
 *
 * Deliberately separate from cashFlow's META map: that one answers "which cash
 * flow section is this", so it labels both `invoice` and `payment` as "Cash
 * received from customers". Here the question is "what do I open", and those
 * two are different records.
 */
const SOURCE_TYPE_LABELS: Record<string, string> = {
  invoice: 'Invoice',
  invoice_void: 'Invoice (voided)',
  payment: 'Customer payment',
  credit_memo: 'Credit memo',
  credit_memo_refund: 'Credit memo refund',
  bill: 'Bill',
  bill_payment: 'Bill payment',
  vendor_credit: 'Vendor credit',
  purchase_order: 'Goods receipt',
  payroll: 'Payroll run',
  tax_payment: 'Tax payment',
  opening_balance: 'Opening balance',
  opening_stock: 'Opening stock',
  inventory_adjustment: 'Inventory adjustment',
  delivery_dispatch: 'Delivery dispatch',
  delivery_approval: 'Delivery approval',
  delivery_return: 'Delivery return',
  delivery_advance_release: 'Delivery advance',
  journal_entry: 'Journal entry',
};

/**
 * The classic bucket keys mapped onto the field names the clients have always
 * read. buildBucketSpec generates keys from the boundaries ('d1to30'), while
 * the wire format predates it ('bucket1to30'); this is the one place the two
 * vocabularies meet.
 */
const LEGACY_FIELD_BY_KEY: Record<string, string> = {
  current: 'current',
  d1to30: 'bucket1to30',
  d31to60: 'bucket31to60',
  d61to90: 'bucket61to90',
  d91plus: 'bucket90Plus',
};

/**
 * A DATE from a raw query, as a plain 'YYYY-MM-DD'. Accepts the string a
 * ::text cast returns and the Date that node-postgres produces without one, so
 * a caller that forgets the cast degrades to the right answer rather than NaN.
 */
const toIsoDay = (v: unknown): string | null => {
  if (!v) return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    const m = `${v.getMonth() + 1}`.padStart(2, '0');
    const d = `${v.getDate()}`.padStart(2, '0');
    return `${v.getFullYear()}-${m}-${d}`;
  }
  const s = String(v).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
};

/**
 * What a dated report covers when the caller names no range.
 *
 * These MUST stay open-ended. Every statement here is computed by filtering
 * general_ledger on `g.date >= $2 AND g.date <= $3` inside a LEFT JOIN, so a
 * missing bound makes the join condition NULL for every row — the report comes
 * back with an entry for each account and zeroes in every column, a blank set
 * of books with no error to explain it. Defaulting to all-time means a caller
 * who omits the range sees everything rather than nothing; a caller who wants
 * a period always passes one (the app always does, from
 * getDefaultReportRange).
 *
 * Exported so ReportsController can apply the same defaults at the edge
 * without a second copy of the literals to drift out of step.
 */
export const REPORT_RANGE_DEFAULTS = {
  startDate: '1970-01-01',
  endDate: '2999-12-31',
} as const;

/** Today, for the reports that close AS OF a date rather than over a range. */
export const reportToday = () => new Date().toISOString().slice(0, 10);

@Injectable()
export class ReportsService {
  private readonly logger = new Logger(ReportsService.name);

  constructor(
    @InjectRepository(Invoice) private readonly invoiceRepo: Repository<Invoice>,
    @InjectRepository(Bill) private readonly billRepo: Repository<Bill>,
    @InjectRepository(InventoryItem) private readonly itemRepo: Repository<InventoryItem>,
    @InjectRepository(InventoryMovement) private readonly moveRepo: Repository<InventoryMovement>,
    @InjectRepository(Delivery) private readonly deliveryRepo: Repository<Delivery>,
    @InjectRepository(TaxPayment) private readonly taxRepo: Repository<TaxPayment>,
    private readonly dataSource: DataSource,
  ) {}

  private async sum(table: 'invoices' | 'bills', col: string, companyId: string, dateCol?: string, s?: string, e?: string) {
    let sql = `SELECT COALESCE(SUM(${col}::numeric),0) AS total FROM ${table} WHERE company_id=$1 AND status NOT IN ('void','draft')`;
    const params: any[] = [companyId];
    if (dateCol && s && e) { sql += ` AND ${dateCol} BETWEEN $2 AND $3`; params.push(s, e); }
    const rows = await this.dataSource.query(sql, params);
    return num(rows[0]?.total);
  }

  // ── Profit & Loss ────────────────────────────────────────────────
  /**
   * GL movements grouped by account within a date range, joined to the chart of
   * accounts. This is the single ledger-derived source the financial statements
   * (P&L, Balance Sheet, Trial Balance) compute from — never document tables —
   * so every number traces back to a posted journal entry (FinMatrixGuide §5.2).
   */
  private async glByAccount(
    companyId: string,
    startDate: string,
    endDate: string,
  ): Promise<
    {
      accountNumber: string;
      accountName: string;
      type: string;
      subType: string;
      dr: string;
      cr: string;
    }[]
  > {
    return this.dataSource.query(
      `SELECT a.account_number AS "accountNumber", a.name AS "accountName",
              a.type AS "type", a.sub_type AS "subType",
              COALESCE(SUM(g.debit::numeric), 0) AS dr,
              COALESCE(SUM(g.credit::numeric), 0) AS cr
       FROM accounts a
       LEFT JOIN general_ledger g
         ON g.account_id = a.id AND g.company_id = $1
         AND g.date >= $2 AND g.date <= $3
       WHERE a.company_id = $1
       GROUP BY a.id, a.account_number, a.name, a.type, a.sub_type
       ORDER BY a.account_number`,
      [companyId, startDate, endDate],
    );
  }

  private isCogs(row: { accountNumber: string; subType: string }): boolean {
    return row.subType === 'Cost of Goods' || row.accountNumber.startsWith('5');
  }

  /**
   * NON-operating income or expense — interest, FX, disposals, one-offs.
   * Kept out of the operating subtotal so `netOperatingIncome` reflects the
   * trade the business actually runs. Mirrors isCogs: number prefix first,
   * explicit subType as the escape hatch for a custom chart.
   */
  private isOther(row: { accountNumber: string; subType: string }): boolean {
    return (
      row.accountNumber.startsWith('7') ||
      row.accountNumber.startsWith('8') ||
      row.subType === 'Other Income' ||
      row.subType === 'Other Expense'
    );
  }

  /**
   * Sort by account code and drop untouched accounts, which would otherwise
   * pad the statement with a row of zeros for every account in the chart.
   */
  private toLines(
    rows: Array<{ accountNumber: string; accountName: string; amount: number }>,
  ): PnlLine[] {
    return rows
      .filter((r) => Math.abs(r.amount) > 0.005)
      .sort((a, b) => a.accountNumber.localeCompare(b.accountNumber))
      .map((r) => ({
        accountCode: r.accountNumber,
        accountName: r.accountName,
        amount: r2(r.amount),
      }));
  }

  /**
   * Period net income from GL rows, using the SAME revenue/expense rules as
   * profitLoss(). Shared so the two statements cannot drift apart.
   */
  private netIncomeFrom(
    rows: Array<{
      type: string;
      dr: string;
      cr: string;
      accountNumber: string;
      subType: string;
    }>,
  ): number {
    let revenue = 0;
    let expense = 0;
    for (const row of rows) {
      const dr = num(row.dr);
      const cr = num(row.cr);
      if (row.type === 'revenue') revenue += cr - dr;
      else if (row.type === 'expense') expense += dr - cr;
    }
    return r2(revenue - expense);
  }

  /**
   * Closing balance per account code as of a date, normal-balance aware:
   * positive means a debit balance for assets/expenses and a credit balance
   * for liabilities/equity/revenue.
   */
  private async balancesAsOf(
    companyId: string,
    asOf: string,
  ): Promise<Map<string, { type: string; subType: string; balance: number }>> {
    const rows = await this.glByAccount(companyId, REPORT_RANGE_DEFAULTS.startDate, asOf);
    const out = new Map<
      string,
      { type: string; subType: string; balance: number }
    >();
    for (const r of rows) {
      const dr = num(r.dr);
      const cr = num(r.cr);
      const balance =
        r.type === 'asset' || r.type === 'expense' ? dr - cr : cr - dr;
      out.set(r.accountNumber, { type: r.type, subType: r.subType, balance });
    }
    return out;
  }

  // ── Profit & Loss (ledger-derived) ───────────────────────────────
  async profitLoss(
    companyId: string,
    startDate: string,
    endDate: string,
  ): Promise<ProfitLossReport> {
    const s = startDate || REPORT_RANGE_DEFAULTS.startDate;
    const e = endDate || REPORT_RANGE_DEFAULTS.endDate;
    const rows = await this.glByAccount(companyId, s, e);

    // The existing five totals, computed exactly as before so their values do
    // not move. `revenue` and `expenses` stay all-inclusive; the operating-only
    // figures live in the new totals below.
    let revenue = 0;
    let cogs = 0;
    let expenses = 0;

    // The same pass now also keeps the per-account detail glByAccount already
    // returned and profitLoss used to discard.
    type Row = { accountNumber: string; accountName: string; amount: number };
    const income: Row[] = [];
    const cogsRows: Row[] = [];
    const expenseRows: Row[] = [];
    const otherIncomeRows: Row[] = [];
    const otherExpenseRows: Row[] = [];

    for (const row of rows) {
      const dr = num(row.dr);
      const cr = num(row.cr);
      const line = (amount: number): Row => ({
        accountNumber: row.accountNumber,
        accountName: row.accountName,
        amount,
      });

      if (row.type === 'revenue') {
        const amt = cr - dr;
        revenue += amt;
        (this.isOther(row) ? otherIncomeRows : income).push(line(amt));
      } else if (row.type === 'expense') {
        const amt = dr - cr;
        if (this.isCogs(row)) {
          cogs += amt;
          cogsRows.push(line(amt));
        } else {
          expenses += amt;
          (this.isOther(row) ? otherExpenseRows : expenseRows).push(line(amt));
        }
      }
    }

    const grossProfit = r2(revenue - cogs);
    const netIncome = r2(grossProfit - expenses);

    const sum = (rs: Row[]) => rs.reduce((t, r) => t + r.amount, 0);
    const totalIncome = r2(sum(income));
    const totalCogs = r2(sum(cogsRows));
    const totalExpenses = r2(sum(expenseRows));
    const netOperatingIncome = r2(grossProfit - totalExpenses);
    const netOtherIncome = r2(sum(otherIncomeRows) - sum(otherExpenseRows));

    return {
      range: { startDate: s, endDate: e },
      comparisonRange: null,
      // ── existing fields, unchanged ──
      revenue: r2(revenue),
      cogs: r2(cogs),
      grossProfit,
      expenses: r2(expenses),
      netIncome,
      // ── added: per-account detail + operating / non-operating split ──
      income: this.toLines(income),
      cogsLines: this.toLines(cogsRows),
      expenseLines: this.toLines(expenseRows),
      otherIncome: this.toLines(otherIncomeRows),
      otherExpense: this.toLines(otherExpenseRows),
      totalIncome,
      totalCogs,
      totalExpenses,
      netOperatingIncome,
      netOtherIncome,
    };
  }

  // ── Balance Sheet (ledger-derived, as of date) ───────────────────
  async balanceSheet(companyId: string, asOfDate: string) {
    const asOf = asOfDate || reportToday();
    const rows = await this.glByAccount(companyId, REPORT_RANGE_DEFAULTS.startDate, asOf);

    const assets: { accountCode: string; accountName: string; amount: number }[] = [];
    const liabilities: { accountCode: string; accountName: string; amount: number }[] = [];
    const equity: { accountCode: string; accountName: string; amount: number }[] = [];
    let revenue = 0;
    let cogs = 0;
    let expense = 0;
    // Footed from the UNROUNDED figures — see the note above the totals.
    let rawAssets = 0;
    let rawLiabilities = 0;
    let rawEquity = 0;

    for (const row of rows) {
      const dr = num(row.dr);
      const cr = num(row.cr);
      const line = (amount: number) => ({
        accountCode: row.accountNumber,
        accountName: row.accountName,
        amount: r2(amount),
      });
      if (row.type === 'asset') {
        const amt = dr - cr;
        if (Math.abs(amt) > 0.0001) {
          assets.push(line(amt));
          rawAssets += amt;
        }
      } else if (row.type === 'liability') {
        const amt = cr - dr;
        if (Math.abs(amt) > 0.0001) {
          liabilities.push(line(amt));
          rawLiabilities += amt;
        }
      } else if (row.type === 'equity') {
        const amt = cr - dr;
        if (Math.abs(amt) > 0.0001) {
          equity.push(line(amt));
          rawEquity += amt;
        }
      } else if (row.type === 'revenue') revenue += cr - dr;
      else if (row.type === 'expense') {
        // Split exactly as profitLoss splits it — see the note below.
        if (this.isCogs(row)) cogs += dr - cr;
        else expense += dr - cr;
      }
    }

    // Current-period earnings (revenue − expense) roll into equity so the sheet
    // balances (FinMatrixGuide §5.3); shown as a Retained Earnings line.
    //
    // The DISPLAYED figure is derived the way profitLoss derives its
    // `netIncome` — via a rounded gross profit — and not by the shorter
    // `r2(revenue - cogs - expense)`. The two are the same number in exact
    // arithmetic and can differ by a paisa in floating point, because
    // Σ round(x) is not round(Σ x): profitLoss rounds gross profit before
    // subtracting expenses, so skipping that intermediate rounding here made
    // the balance sheet's equity disagree with the P&L's bottom line by 0.01
    // whenever the value landed on a half-paisa boundary. A balance sheet whose
    // net income does not match the P&L's is a reason to distrust both.
    //
    // rawNetIncome stays at FULL precision, because it is what rolls into
    // rawEquity and therefore what decides whether A = L + E.
    const rawNetIncome = revenue - cogs - expense;
    const netIncome = r2(r2(revenue - cogs) - expense);
    if (Math.abs(netIncome) > 0.0001) {
      equity.push({
        accountCode: '3100',
        accountName: 'Net Income (current period)',
        amount: netIncome,
      });
      rawEquity += rawNetIncome;
    }

    // Foot the sections from the UNROUNDED amounts, then round once.
    //
    // Adding up the rounded line items instead lets the statement fail to
    // balance: Σ round(x) is not round(Σ x), and the ledger carries four
    // decimals, so each line can hide up to half a paisa that compounds across
    // thirty-odd accounts. The lines stay rounded for presentation — only the
    // arithmetic that has to tie is done at full precision. Every posted entry
    // balances, so A = L + E holds exactly on the raw figures.
    const totalAssets = r2(rawAssets);
    const totalLiabilities = r2(rawLiabilities);
    const totalEquity = r2(rawEquity);

    // The VERDICT is taken on the raw figures too, for the same reason the
    // totals are. Testing the three rounded ones instead reintroduces the bug
    // a step later: each can move by up to half a paisa, so a statement that
    // ties exactly in the ledger can report a gap of a full paisa or more and
    // announce that the books do not balance. They do; the arithmetic that
    // said otherwise was the presentation rounding, not the accounts.
    const isBalanced = Math.abs(rawAssets - (rawLiabilities + rawEquity)) < 0.01;
    return {
      asOfDate: asOf,
      assets,
      liabilities,
      equity,
      totalAssets,
      totalLiabilities,
      totalEquity,
      isBalanced,
    };
  }

  // ── A/R Aging (bucketed) ─────────────────────────────────────────
  //
  // due_date is cast to text on purpose. It is a DATE column, and node-postgres
  // parses DATE into a JS Date at LOCAL midnight — so the value that came back
  // depended on the server's zone before it reached any of our arithmetic.
  // ::text hands us the stored calendar day verbatim.
  /**
   * The company's saved aging preference, if any.
   *
   * Resolved server-side rather than by the client so that a saved default also
   * governs the CSV export and every other consumer, not just the screen that
   * set it.
   */
  private async savedAgingPreference(companyId: string): Promise<AgingSpecRequest | null> {
    try {
      const rows = await this.dataSource.query(
        `SELECT report_preferences AS prefs FROM company_settings WHERE company_id = $1`,
        [companyId],
      );
      const aging = rows?.[0]?.prefs?.aging;
      if (!aging || typeof aging !== 'object') return null;
      return {
        preset: typeof aging.preset === 'string' ? aging.preset : null,
        buckets: typeof aging.buckets === 'string' ? aging.buckets : null,
      };
    } catch (err: any) {
      // 42703 = undefined_column: the report_preferences migration has not run
      // on this database. Two reports going dark is a worse outcome than
      // quietly using the default, but a silently skipped migration is worth
      // saying out loud.
      if (err?.code === '42703') {
        this.logger.warn(
          'company_settings.report_preferences is missing — aging is using the default buckets. Run migrations.',
        );
        return null;
      }
      throw err;
    }
  }

  /**
   * Settle the bucket set for a request. A request that fully specifies itself
   * skips the settings lookup — analyticsDashboard reads only the legacy
   * scalars and has no reason to pay for a round trip.
   */
  private async resolveSpecFor(
    companyId: string,
    request?: AgingSpecRequest,
  ): Promise<ResolvedAgingSpec> {
    const selfContained =
      !!request && (request.preset === 'custom' ? !!request.buckets : !!request.preset || !!request.buckets);
    try {
      return resolveAgingSpec(request ?? null, selfContained ? null : await this.savedAgingPreference(companyId));
    } catch (err) {
      if (err instanceof AgingBucketSpecError) {
        throw new BadRequestException({ code: 'INVALID_AGING_BUCKETS', message: err.message });
      }
      throw err;
    }
  }

  async arAging(companyId: string, request?: AgingSpecRequest) {
    const spec = await this.resolveSpecFor(companyId, request);
    const rowsRaw = await this.dataSource.query(
      `SELECT i.customer_id AS "customerId", c.name AS "customerName", i.balance::numeric AS balance, i.due_date::text AS "dueDate"
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE i.company_id=$1 AND ${openDocPredicate('i')}`, [companyId]);
    return this.bucketAging(rowsRaw, spec, 'customerId', 'customerName');
  }

  async apAging(companyId: string, request?: AgingSpecRequest) {
    const spec = await this.resolveSpecFor(companyId, request);
    const rowsRaw = await this.dataSource.query(
      `SELECT b.vendor_id AS "customerId", v.company_name AS "customerName", b.balance::numeric AS balance, b.due_date::text AS "dueDate"
       FROM bills b JOIN vendors v ON v.id = b.vendor_id
       WHERE b.company_id=$1 AND ${openDocPredicate('b')}`, [companyId]);
    return this.bucketAging(rowsRaw, spec, 'customerId', 'customerName');
  }

  /**
   * One party's open documents behind its aging row — the AR side.
   *
   * @see agingPartyDocuments for why this is here and not in InvoicesService.
   */
  async arAgingPartyDocuments(
    companyId: string,
    customerId: string,
    request?: AgingSpecRequest,
    bucket?: string,
    page = 1,
    limit = 50,
  ) {
    return this.agingPartyDocuments({
      companyId,
      partyId: customerId,
      partyType: 'customer',
      partyQuery: `SELECT c.name AS name FROM customers c WHERE c.id = $1 AND c.company_id = $2 LIMIT 1`,
      docQuery:
        `SELECT i.id AS "documentId", i.invoice_number AS "documentNumber",
                i.invoice_date::text AS "issueDate", i.due_date::text AS "dueDate",
                i.total::numeric AS total, i.amount_paid::numeric AS "amountPaid",
                i.balance::numeric AS balance, i.status
           FROM invoices i
          WHERE i.company_id = $1 AND i.customer_id = $2 AND ${openDocPredicate('i')}
          ORDER BY i.due_date ASC, i.invoice_number ASC`,
      documentType: 'invoice',
      request,
      bucket,
      page,
      limit,
    });
  }

  /** One party's open documents behind its aging row — the AP side. */
  async apAgingPartyDocuments(
    companyId: string,
    vendorId: string,
    request?: AgingSpecRequest,
    bucket?: string,
    page = 1,
    limit = 50,
  ) {
    return this.agingPartyDocuments({
      companyId,
      partyId: vendorId,
      partyType: 'vendor',
      partyQuery: `SELECT v.company_name AS name FROM vendors v WHERE v.id = $1 AND v.company_id = $2 LIMIT 1`,
      docQuery:
        `SELECT b.id AS "documentId", b.bill_number AS "documentNumber",
                b.bill_date::text AS "issueDate", b.due_date::text AS "dueDate",
                b.total::numeric AS total, b.amount_paid::numeric AS "amountPaid",
                b.balance::numeric AS balance, b.status
           FROM bills b
          WHERE b.company_id = $1 AND b.vendor_id = $2 AND ${openDocPredicate('b')}
          ORDER BY b.due_date ASC, b.bill_number ASC`,
      documentType: 'bill',
      request,
      bucket,
      page,
      limit,
    });
  }

  /**
   * The open documents behind one aging row.
   *
   * ── Why this lives here and not in InvoicesService ──────────────────────
   * `InvoicesService.outstandingForCustomer` looks like the function for this
   * job and is not: its predicate is `status NOT IN ('draft','void')`, which
   * does NOT exclude `paid`, while aging does. Under `balance > 0` the two
   * coincide in practice — and "coincides in practice" is exactly the
   * assumption that makes a drill-down disagree with the row it opened from,
   * months later, for one company, over one invoice. Both sides read
   * `openDocPredicate` instead, so they cannot drift apart. There is
   * deliberately no vendor twin of that method either; this is the one place
   * that knows what "open" means for aging.
   *
   * ── Why the bucketing is in JS and the pagination is not in SQL ─────────
   * Each document is bucketed with the same `bucketKeyFor` the report uses.
   * Filtering by bucket in SQL would need a second implementation of it in
   * Postgres, which is the duplication `aging-buckets.ts` exists to prevent, so
   * the filter runs here — and `LIMIT`/`OFFSET` therefore cannot, or pages
   * would be short and `total` would not foot. The set is one party's open
   * documents: smaller than what arAging already loads for the whole company.
   *
   * ── The contract ────────────────────────────────────────────────────────
   * With no bucket, `outstandingTotal` equals that party's aging row total.
   * With one, it equals `row.amounts[bucket]`. `daysOverdue` is signed, so a
   * document not yet due reports a negative number and the client can say "due
   * in 4 days" without recomputing anything.
   */
  private async agingPartyDocuments(args: {
    companyId: string;
    partyId: string;
    partyType: 'customer' | 'vendor';
    partyQuery: string;
    docQuery: string;
    documentType: 'invoice' | 'bill';
    request?: AgingSpecRequest;
    bucket?: string;
    page: number;
    limit: number;
  }) {
    const {
      companyId, partyId, partyType, partyQuery, docQuery, documentType,
      request, bucket, page, limit,
    } = args;

    // The same resolution arAging performs, so the detail's buckets ARE the
    // report's buckets rather than merely resembling them.
    const resolved = await this.resolveSpecFor(companyId, request);
    const spec = resolved.spec;

    if (bucket && !spec.some((b) => b.key === bucket)) {
      // Not an empty list: an unknown key means the client and the bucket spec
      // have drifted, and "nothing in this bucket" would hide that.
      throw new BadRequestException({
        code: 'UNKNOWN_AGING_BUCKET',
        message: `No bucket ${bucket} in this report. Buckets: ${spec.map((b) => b.key).join(', ')}.`,
      });
    }

    const partyRows = await this.dataSource.query(partyQuery, [partyId, companyId]);
    const partyName = partyRows?.[0]?.name;
    if (partyName === undefined) {
      // An empty document list would read as "this party owes nothing", a
      // materially more reassuring claim than "there is no such party".
      throw new NotFoundException({
        code: partyType === 'customer' ? 'CUSTOMER_NOT_FOUND' : 'VENDOR_NOT_FOUND',
        message: `No ${partyType} with id ${partyId} in this company.`,
      });
    }

    const raw: any[] = await this.dataSource.query(docQuery, [companyId, partyId]);
    const asOfDate = businessToday();
    const labelFor = new Map(spec.map((b) => [b.key, b.label]));

    const all = raw.map((r) => {
      // Identical to bucketAging: calendar days in the business zone, off the
      // stored date, never elapsed milliseconds.
      const due = toIsoDay(r.dueDate);
      const daysOverdue = due === null ? 0 : daysBetweenIso(due, asOfDate);
      const bucketKey = bucketKeyFor(daysOverdue, spec);
      return {
        documentId: r.documentId,
        documentType,
        documentNumber: r.documentNumber ?? null,
        issueDate: r.issueDate ?? null,
        dueDate: r.dueDate ?? null,
        daysOverdue,
        bucketKey,
        bucketLabel: labelFor.get(bucketKey) ?? bucketKey,
        total: r2(num(r.total)),
        amountPaid: r2(num(r.amountPaid)),
        balance: r2(num(r.balance)),
        status: r.status,
      };
    });

    const matching = bucket ? all.filter((d) => d.bucketKey === bucket) : all;
    // Over every matching document, not just this page — this is the figure
    // that has to foot to the aging row.
    const outstandingTotal = r2(matching.reduce((t, d) => t + d.balance, 0));

    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const safePage = Math.max(Math.trunc(page) || 1, 1);
    const start = (safePage - 1) * safeLimit;

    return {
      partyType,
      partyId,
      partyName,
      asOfDate,
      preset: resolved.preset,
      buckets: spec,
      bucket: bucket ?? null,
      outstandingTotal,
      // NOT `data`: ResponseEnvelopeInterceptor lifts a `data` key into the
      // envelope slot and discards every sibling, which is how the P&L
      // drill-down shipped without its metadata for months. NOT `entries`
      // either — that means posted ledger rows everywhere else in this
      // codebase, and these are open source documents.
      documents: matching.slice(start, start + safeLimit),
      total: matching.length,
      page: safePage,
      limit: safeLimit,
    };
  }

  /**
   * Slice open balances by how overdue they are.
   *
   * Emits TWO shapes over one pass of the data:
   *
   *  - `buckets[]` + `amounts` — the configurable set the caller asked for,
   *    self-describing so a client renders columns from the payload rather than
   *    from five names compiled into it.
   *  - the five `current`/`bucket1to30`/… scalars — ALWAYS on 30/60/90,
   *    whatever preset was requested. A shipped Android build, the live
   *    website, analyticsDashboard's arAgingTrend and three CI suites read
   *    these. Re-bucketing changes how the money is sliced, never how much of
   *    it there is, so both shapes describe the same books without disagreeing
   *    and `total` is identical under every preset.
   */
  private bucketAging(
    rowsRaw: any[],
    requested: ResolvedAgingSpec | undefined,
    idKey: string,
    nameKey: string,
  ) {
    const resolved = requested ?? resolveAgingSpec(null, null);
    const spec = resolved.spec;
    const legacySpec = buildBucketSpec([...LEGACY_BOUNDARIES]);
    const asOfDate = businessToday();

    const zeroAmounts = () => Object.fromEntries(spec.map((b) => [b.key, 0])) as Record<string, number>;
    const blankLegacy = () => ({
      current: 0, bucket1to30: 0, bucket31to60: 0, bucket61to90: 0, bucket90Plus: 0,
    });

    const map = new Map<string, any>();
    for (const row of rowsRaw) {
      const id = row[idKey];
      const name = row[nameKey] ?? 'Unknown';
      const bal = num(row.balance);
      // due_date is NOT NULL on both invoices and bills, so this guard should
      // never fire. It is here because the old code read a missing date as
      // Invalid Date, which failed every `age <=` comparison and silently
      // dropped the balance into 90-plus — the worst possible default.
      const due = toIsoDay(row.dueDate);
      const age = due === null ? 0 : daysBetweenIso(due, asOfDate);

      if (!map.has(id)) {
        map.set(id, { customerId: id, customerName: name, amounts: zeroAmounts(), total: 0, ...blankLegacy() });
      }
      const e = map.get(id);
      e.amounts[bucketKeyFor(age, spec)] += bal;
      e[LEGACY_FIELD_BY_KEY[bucketKeyFor(age, legacySpec)]] += bal;
      e.total += bal;
    }

    const rows = Array.from(map.values())
      .map((e) => ({
        ...e,
        amounts: Object.fromEntries(
          Object.entries(e.amounts).map(([k, v]) => [k, r2(v as number)]),
        ) as Record<string, number>,
        current: r2(e.current), bucket1to30: r2(e.bucket1to30), bucket31to60: r2(e.bucket31to60),
        bucket61to90: r2(e.bucket61to90), bucket90Plus: r2(e.bucket90Plus), total: r2(e.total),
      }))
      .sort((a, b) => b.total - a.total);

    const totals = rows.reduce(
      (t, e) => {
        for (const b of spec) t.amounts[b.key] += e.amounts[b.key];
        t.current += e.current; t.bucket1to30 += e.bucket1to30;
        t.bucket31to60 += e.bucket31to60; t.bucket61to90 += e.bucket61to90;
        t.bucket90Plus += e.bucket90Plus; t.total += e.total;
        return t;
      },
      { amounts: zeroAmounts(), ...blankLegacy(), total: 0 },
    );
    for (const b of spec) totals.amounts[b.key] = r2(totals.amounts[b.key]);
    for (const k of ['current', 'bucket1to30', 'bucket31to60', 'bucket61to90', 'bucket90Plus', 'total'] as const) {
      totals[k] = r2(totals[k]);
    }

    return { asOfDate, preset: resolved.preset, buckets: spec, rows, totals };
  }

  /**
   * The transactions behind one statement line.
   *
   * A P&L line is a SUM over general_ledger grouped by account — the account
   * code is the only thing that survives the grouping. This walks back to the
   * rows that made it, which is the difference between "Office Expenses is
   * 41,200" and "…and here is the bill that put 9,000 of it there".
   *
   * Reads general_ledger, NOT LedgerService. They are different tables:
   * LedgerService reads journal_entry_lines, which has no source_type/source_id
   * and labels every row 'journal_entry' — so it cannot say which document a
   * figure came from, which is the entire point of a drill-down. general_ledger
   * carries both columns NOT NULL and is indexed (company_id, account_id, date).
   *
   * `amount` is signed the way the statement reads the account, so summing it
   * over every page reproduces the line exactly. That identity is the contract
   * this endpoint exists to keep, and it is pinned by a test.
   *
   * Paginated, unlike /ledger, and ordered NEWEST FIRST. A drill-down on Sales
   * Revenue over a year is every invoice the company has ever issued; showing
   * the oldest fifty of those puts the least interesting end of the account on
   * screen and makes recent activity unreachable.
   */
  async statementLineEntries(
    companyId: string,
    accountCode: string,
    startDate: string,
    endDate: string,
    page = 1,
    limit = 50,
  ) {
    const s = startDate || REPORT_RANGE_DEFAULTS.startDate;
    const e = endDate || REPORT_RANGE_DEFAULTS.endDate;
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const safePage = Math.max(Math.trunc(page) || 1, 1);

    const accounts = await this.dataSource.query(
      `SELECT a.id, a.account_number AS "accountCode", a.name AS "accountName",
              a.type AS "accountType", a.sub_type AS "subType"
         FROM accounts a
        WHERE a.company_id = $1 AND a.account_number = $2
        LIMIT 1`,
      [companyId, accountCode],
    );
    const account = accounts?.[0];
    if (!account) {
      // An empty list would read as "this account had no activity", which is a
      // different and much more reassuring claim than "there is no such
      // account". The clients pass a code straight off a statement line, so
      // this firing means they have drifted apart.
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: `No account numbered ${accountCode} in this company.`,
      });
    }

    const where = `g.company_id = $1 AND g.account_id = $2 AND g.date >= $3 AND g.date <= $4`;
    const params = [companyId, account.id, s, e];

    const [totals] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS cnt,
              COALESCE(SUM(g.debit::numeric), 0) AS dr,
              COALESCE(SUM(g.credit::numeric), 0) AS cr
         FROM general_ledger g WHERE ${where}`,
      params,
    );

    // Resolve the DOCUMENT behind each row, not just the journal entry that
    // recorded it.
    //
    // `g.reference` is the JE number (JE-005). That identifies the posting, and
    // a posting is not what anyone is looking for: asked "what is in Sales
    // Revenue", the answer is INV-2026-0001 for Acme Ltd, not JE-005. One LEFT
    // JOIN per source family, keyed on (source_type, source_id) — a join per
    // family, not per row.
    //
    // Deliveries need their own join even though they post through an invoice:
    // the GL row carries the DELIVERY's id, not the invoice's, so without this
    // a delivery-approval COGS row falls back to its journal number and names
    // nobody.
    const rows = await this.dataSource.query(
      `SELECT g.id, g.date::text AS date, g.reference, g.memo,
              g.debit::numeric AS debit, g.credit::numeric AS credit,
              g.source_type AS "sourceType", g.source_id AS "sourceId",
              COALESCE(inv.invoice_number, bl.bill_number, cm.credit_memo_number,
                       vc.vendor_credit_number, po.po_number,
                       pay.payment_number, bp.reference,
                       dinv.invoice_number, dl.reference_no)   AS "documentNumber",
              COALESCE(ic.name, cc.name, pc.name,
                       bv.company_name, vv.company_name,
                       pv.company_name, bpv.company_name,
                       dc.name)                                AS "counterpartyName"
         FROM general_ledger g
         LEFT JOIN invoices inv       ON inv.id = g.source_id
                                     AND g.source_type IN ('invoice','invoice_void')
         LEFT JOIN customers ic       ON ic.id = inv.customer_id
         LEFT JOIN bills bl           ON bl.id = g.source_id
                                     AND g.source_type IN ('bill','bill_void')
         LEFT JOIN vendors bv         ON bv.id = bl.vendor_id
         LEFT JOIN credit_memos cm    ON cm.id = g.source_id
                                     AND g.source_type IN ('credit_memo','credit_memo_void','credit_memo_refund')
         LEFT JOIN customers cc       ON cc.id = cm.customer_id
         LEFT JOIN vendor_credits vc  ON vc.id = g.source_id
                                     AND g.source_type IN ('vendor_credit','vendor_credit_void')
         LEFT JOIN vendors vv         ON vv.id = vc.vendor_id
         LEFT JOIN purchase_orders po ON po.id = g.source_id
                                     AND g.source_type IN ('purchase_order','po_receipt')
         LEFT JOIN vendors pv         ON pv.id = po.vendor_id
         LEFT JOIN payments pay       ON pay.id = g.source_id
                                     AND g.source_type = 'payment'
         LEFT JOIN customers pc       ON pc.id = pay.customer_id
         LEFT JOIN bill_payments bp   ON bp.id = g.source_id
                                     AND g.source_type = 'bill_payment'
         LEFT JOIN vendors bpv        ON bpv.id = bp.vendor_id
         LEFT JOIN deliveries dl      ON dl.id = g.source_id
                                     AND g.source_type LIKE 'delivery%'
         LEFT JOIN invoices dinv      ON dinv.id = dl.invoice_id
         LEFT JOIN customers dc       ON dc.id = dl.customer_id
        WHERE ${where}
        ORDER BY g.date DESC, g.created_at DESC
        LIMIT $5 OFFSET $6`,
      [...params, safeLimit, (safePage - 1) * safeLimit],
    );

    // Signed the way the statement reads this account's normal balance, so the
    // entries add up to the figure the user tapped rather than to its negative.
    const creditNormal =
      account.accountType === 'revenue' ||
      account.accountType === 'liability' ||
      account.accountType === 'equity';
    const signed = (dr: number, cr: number) => (creditNormal ? cr - dr : dr - cr);

    return {
      accountCode: account.accountCode,
      accountName: account.accountName,
      accountType: account.accountType,
      range: { startDate: s, endDate: e },
      // The whole range, not this page — it is what the statement line shows.
      lineAmount: r2(signed(num(totals?.dr), num(totals?.cr))),
      // `entries`, NOT `data`. ResponseEnvelopeInterceptor lifts a returned
      // `data` key into the envelope slot and DISCARDS every sibling, so
      // calling this `data` put a bare array on the wire and threw away
      // accountCode, lineAmount, total, page and limit. Both clients then
      // looked for `.data` on an array, found nothing, and rendered "No
      // transactions in this period." for every account in every period.
      //
      // Nothing here may be named `data` again. See the note in
      // response-envelope.interceptor.ts.
      entries: rows.map((row: any) => ({
        id: row.id,
        date: row.date,
        reference: row.reference,
        memo: row.memo,
        debit: r2(num(row.debit)),
        credit: r2(num(row.credit)),
        amount: r2(signed(num(row.debit), num(row.credit))),
        sourceType: row.sourceType,
        sourceId: row.sourceId,
        sourceLabel: SOURCE_TYPE_LABELS[row.sourceType] ?? 'Journal entry',
        // The document's own number — INV-2026-0001 — falling back to the
        // journal reference when the row is a manual entry with no document.
        documentNumber: row.documentNumber ?? row.reference ?? null,
        counterpartyName: row.counterpartyName ?? null,
      })),
      total: totals?.cnt ?? 0,
      page: safePage,
      limit: safeLimit,
    };
  }

  // ── Inventory Valuation ──────────────────────────────────────────
  async inventoryValuation(companyId: string) {
    const items = await this.itemRepo.find({ where: { companyId } });
    const rows = items.map((it) => {
      const qty = num(it.quantityOnHand);
      const cost = num(it.unitCost);
      return { itemId: it.id, itemName: it.name, sku: it.sku, category: it.category ?? 'Uncategorized', qty, cost, value: r2(qty * cost) };
    }).sort((a, b) => b.value - a.value);
    const catMap = new Map<string, number>();
    for (const row of rows) catMap.set(row.category, (catMap.get(row.category) ?? 0) + row.value);
    const byCategory = Array.from(catMap.entries()).map(([category, totalValue]) => ({ category, totalValue: r2(totalValue) }));
    const totalValue = r2(rows.reduce((a, x) => a + x.value, 0));
    return { rows, byCategory, totalValue };
  }

  /**
   * What the company's stock has been worth, month by month.
   *
   * Straight off general_ledger account 1200, which makes every point EXACT and
   * tied to the balance sheet by construction — the same identity
   * test/demo-invariants.ts already asserts for the current snapshot, extended
   * backwards. No new column and no estimate: the ledger has always recorded
   * what inventory was worth, only nothing ever asked it.
   *
   * Closing balance, not movement, so the series answers "what was stock worth
   * at the end of March" rather than "how much did it change in March". Months
   * with no movement carry the previous close forward instead of reading zero.
   */
  async inventoryValuationTrend(companyId: string, months = 12) {
    const count = Math.min(Math.max(Math.trunc(months) || 12, 1), 60);
    const window = monthWindow(businessToday(), count);

    const rows = await this.dataSource.query(
      `SELECT to_char(g.date, 'YYYY-MM') AS period,
              COALESCE(SUM(g.debit::numeric - g.credit::numeric), 0) AS net
         FROM general_ledger g
         JOIN accounts a ON a.id = g.account_id AND a.company_id = g.company_id
        WHERE g.company_id = $1 AND a.account_number = '1200'
        GROUP BY period
        ORDER BY period`,
      [companyId],
    );

    const netByPeriod = new Map<string, number>(
      rows.map((r: any) => [r.period as string, num(r.net)]),
    );

    // Everything posted before the window opens is the opening balance, so the
    // first point is a real closing value rather than one month's movement.
    const first = window[0].period;
    let running = 0;
    for (const [period, net] of netByPeriod) {
      if (period < first) running += net;
    }

    const points = window.map((slot) => {
      running += netByPeriod.get(slot.period) ?? 0;
      return {
        period: slot.period,
        label: slot.label,
        asOfDate: slot.endDate,
        value: r2(running),
      };
    });

    return { months: count, points };
  }

  /**
   * One item's stock level and value, month by month.
   *
   * Both are reconstructed the way `companies.inventory_cost_history_from`
   * documents: anchor on TODAY — quantity_on_hand, and quantity_on_hand ×
   * unit_cost, which I13 ties to GL 1200 — and walk BACKWARDS through the
   * dated movements. A month's close is today's figure less everything dated
   * after that month ended. So the latest point is exactly what the valuation
   * table shows for the item, and every earlier point is what the dated
   * record says, the same way the ledger dates a posting.
   *
   * Quantity used to be read from the `balance_after` snapshot of each
   * month's last-dated movement instead. That follows the order documents
   * were TYPED IN, not their dates, and a back-dated document breaks it: an
   * invoice dated April but entered in July carries July's running balance,
   * so April read 24 on the shelf while the dated record says 16 short, and
   * the current month could disagree with the quantity on hand outright. The
   * walk cannot: it ends on the true quantity by construction, and quantity
   * and value always describe the same stock. A month that goes BELOW zero is
   * real information — goods were invoiced before their receipt was dated —
   * and is reported rather than smoothed over (see `coverage.message`).
   *
   * Value is exact for every month ending on or after the horizon and
   * undefined before it, so earlier months come back null with `valueKnown:
   * false` — the uncertainty stays at the old end of the chart instead of
   * seeping into recent months as a made-up opening balance. A movement that
   * carries no value leaves a hole in the walk, so nothing before it is
   * claimed either.
   *
   * The window is either the last `months` months or, given a range, the whole
   * months it touches (at most 60) — so the stock charts line up with the
   * sales charts beside them on the item explorer.
   */
  async inventoryItemHistory(
    companyId: string,
    itemId: string,
    months = 12,
    range?: { startDate?: string; endDate?: string },
  ) {
    const item = await this.findItemOrFail(companyId, itemId);

    let window: MonthSlot[];
    if (range?.startDate && range?.endDate) {
      const count = Math.min(
        Math.max(monthSpan(range.startDate, range.endDate), 1),
        60,
      );
      window = monthWindow(range.endDate, count);
    } else {
      window = monthWindow(
        businessToday(),
        Math.min(Math.max(Math.trunc(months) || 12, 1), 60),
      );
    }
    const count = window.length;

    // `since` rides along on every row rather than costing a second round
    // trip; with no movements there is nothing to value anyway.
    const rows = await this.dataSource.query(
      `SELECT to_char(m.date, 'YYYY-MM') AS period,
              COALESCE(SUM(CASE WHEN m.quantity_change::numeric > 0
                                THEN m.quantity_change::numeric ELSE 0 END), 0) AS qty_in,
              COALESCE(SUM(CASE WHEN m.quantity_change::numeric < 0
                                THEN -m.quantity_change::numeric ELSE 0 END), 0) AS qty_out,
              COALESCE(SUM(m.value_change::numeric), 0) AS value_net,
              bool_or(m.value_change IS NULL) AS value_missing,
              (SELECT c.inventory_cost_history_from::text
                 FROM companies c WHERE c.id = $1) AS since
         FROM inventory_movements m
        WHERE m.company_id = $1 AND m.item_id = $2
        GROUP BY period
        ORDER BY period`,
      [companyId, itemId],
    );

    const byPeriod = new Map<string, any>(rows.map((r: any) => [r.period as string, r]));
    const since = toIsoDay(rows[0]?.since);
    const firstMovement = rows.length ? (rows[0].period as string) : null;

    const qtyNow = num(item.quantityOnHand);
    const valueNow = qtyNow * num(item.unitCost);

    // Walking backwards: what moved AFTER each month — quantity and value —
    // and whether any of it carries no value (a hole in the walk).
    const after = new Map<
      string,
      { qty: number; value: number; missing: boolean }
    >();
    let laterQty = 0;
    let laterValue = 0;
    let laterMissing = false;
    for (let i = rows.length - 1, w = count - 1; w >= 0; w--) {
      const slot = window[w];
      while (i >= 0 && (rows[i].period as string) > slot.period) {
        laterQty += num(rows[i].qty_in) - num(rows[i].qty_out);
        laterValue += num(rows[i].value_net);
        laterMissing = laterMissing || rows[i].value_missing === true;
        i--;
      }
      after.set(slot.period, {
        qty: laterQty,
        value: laterValue,
        missing: laterMissing,
      });
    }

    const points = window.map((slot) => {
      const row = byPeriod.get(slot.period);
      const later = after.get(slot.period)!;
      // Before the item's first movement it did not exist on any shelf: null,
      // which says "not yet", where a zero would invent a stockout.
      const existed = firstMovement !== null && slot.period >= firstMovement;
      const valueKnown =
        existed && since !== null && slot.endDate >= since && !later.missing;
      return {
        period: slot.period,
        label: slot.label,
        asOfDate: slot.endDate,
        closingQty: existed ? r2(qtyNow - later.qty) : null,
        qtyIn: r2(num(row?.qty_in)),
        qtyOut: r2(num(row?.qty_out)),
        closingValue: valueKnown ? r2(valueNow - later.value) : null,
        valueKnown,
      };
    });

    const knownCount = points.filter((p) => p.valueKnown).length;
    const existing = points.filter((p) => p.closingQty !== null).length;
    const value =
      knownCount === 0
        ? 'unavailable'
        : knownCount === existing
          ? 'exact'
          : 'partial';
    const short = points.find((p) => p.closingQty !== null && p.closingQty < 0);

    const notes: string[] = [];
    if (since === null && existing > 0) {
      notes.push(
        'Month-end value is not shown: no stock movement in this company has recorded its cost yet.',
      );
    } else if (value === 'partial') {
      notes.push(
        `Month-end value is shown from ${since}, when cost began to be recorded on every ` +
          "stock movement; valuing earlier quantities at today's average cost would misstate them.",
      );
    }
    if (short) {
      notes.push(
        `Stock is below zero at the end of ${short.label} by document date: goods were ` +
          'invoiced before the receipt that supplied them was dated.',
      );
    }

    return {
      itemId: item.id,
      itemName: item.name,
      sku: item.sku,
      months: count,
      points,
      coverage: {
        quantity: 'exact',
        value,
        costHistoryFrom: since,
        message: notes.join(' '),
      },
    };
  }

  /** The item, scoped to the company, or a 404 that says so. */
  private async findItemOrFail(companyId: string, itemId: string) {
    const items = await this.itemRepo.find({
      where: { id: itemId, companyId },
    });
    const item = items[0];
    if (!item) {
      throw new NotFoundException({
        code: 'ITEM_NOT_FOUND',
        message: 'No such inventory item in this company.',
      });
    }
    return item;
  }

  /**
   * Every document line that sold (or took back) an item, one row each.
   *
   * The single source for per-item sales. `itemSalesUnionSql` groups it by
   * month, the item explorer's "what's behind this month" pages through it,
   * and top customers group it by customer — so the three can never disagree
   * about what an item sold. `$1` is the company, `$2`/`$3` the date range,
   * and `$4` — when `byItem` is false — the single item.
   *
   * Columns: item_id, date, period, doc_type ('invoice' | 'delivery' |
   * 'credit_memo'), doc_id (the document to open — for a delivery, the invoice
   * it raised), doc_number, customer_id, line_id, units, revenue, cogs,
   * est_cogs, cost_missing, cost_basis.
   *
   * ── Revenue is NET OF TAX ─────────────────────────────────────────────────
   * `line_total` INCLUDES tax; the ledger posts revenue net of it. Measured on
   * real books: 59 invoices differed and the gap was exactly the sum of tax.
   *
   * ── …and NET OF THE INVOICE DISCOUNT ──────────────────────────────────────
   * A discount is set on the invoice, not the line, and the ledger credits
   * 4000 with `subtotal − discount_amount`. Each line takes its share of it in
   * proportion to its pre-tax amount (`subtotal` is the sum of those), which
   * is how an invoice's lines add back up to the revenue the ledger posted.
   * Before this, a discounted invoice overstated every item on it and the
   * difference sat unexplained in the reconciliation's residual.
   *
   * ── Customer returns are SALES, and are netted here ───────────────────────
   * A credit memo reverses a sale, so it reduces that item's revenue and cost.
   * Both are attributable: `credit_memo_lines` carries `item_id` and the
   * restock cost frozen at the time.
   *
   * ── Purchase returns are NOT ──────────────────────────────────────────────
   * A vendor credit sends goods back to a supplier. It moves GL 5000, but it is
   * not a cost of anything sold, and folding it into an item's cost of SALES
   * would distort the margin. It surfaces in the reconciliation instead.
   *
   * ── The delivery arm is not optional ──────────────────────────────────────
   * An invoice raised for a delivery carries `lineKind: 'service'` and no
   * `item_id`, deliberately, so posting does not relieve stock twice. Built on
   * invoice lines alone this query would report zero revenue for every item
   * sold through the delivery flow. The arms are disjoint, so nothing is
   * double-counted. Delivery `unit_price` is already tax-exclusive.
   */
  private itemSalesLinesSql(byItem: boolean): string {
    const itemFilter = byItem ? '' : 'AND %ALIAS%.item_id = $4';
    const inv = itemFilter.replace('%ALIAS%', 'li');
    const del = itemFilter.replace('%ALIAS%', 'di');
    const cm = itemFilter.replace('%ALIAS%', 'cml');
    // The share of an invoice's pre-tax amount that survives its discount.
    const kept = `(CASE WHEN i.subtotal::numeric > 0
                        THEN 1 - COALESCE(i.discount_amount, 0)::numeric / i.subtotal::numeric
                        ELSE 1 END)`;
    return `
      SELECT li.item_id AS item_id,
             i.invoice_date AS date,
             to_char(i.invoice_date, 'YYYY-MM') AS period,
             'invoice'::text AS doc_type,
             i.id AS doc_id,
             i.invoice_number::text AS doc_number,
             i.customer_id AS customer_id,
             li.id AS line_id,
             li.quantity::numeric AS units,
             ((li.line_total - COALESCE(li.tax_amount, 0)) * ${kept})::numeric(18,4) AS revenue,
             COALESCE(li.cost_amount, 0)::numeric AS cogs,
             (CASE WHEN li.cost_basis = 'apportioned'
                   THEN COALESCE(li.cost_amount, 0) ELSE 0 END)::numeric AS est_cogs,
             (li.cost_amount IS NULL) AS cost_missing,
             COALESCE(li.cost_basis, 'unknown')::text AS cost_basis
        FROM invoice_line_items li
        JOIN invoices i ON i.id = li.invoice_id
       WHERE i.company_id = $1 AND li.item_id IS NOT NULL ${inv}
         AND i.status NOT IN ('draft', 'void')
         AND i.invoice_date >= $2 AND i.invoice_date <= $3

      UNION ALL

      SELECT di.item_id,
             i.invoice_date,
             to_char(i.invoice_date, 'YYYY-MM'),
             'delivery'::text,
             i.id,
             i.invoice_number::text,
             COALESCE(d.customer_id, i.customer_id),
             di.id,
             di.delivered_qty::numeric,
             (di.delivered_qty * di.unit_price * ${kept})::numeric(18,4),
             (di.delivered_qty * di.unit_cost)::numeric,
             0::numeric,
             false,
             'delivery'::text
        FROM delivery_items di
        JOIN deliveries d ON d.id = di.delivery_id
        JOIN invoices i   ON i.id = d.invoice_id
       WHERE d.company_id = $1 ${del}
         AND d.ledger_status = 'committed'
         AND i.status NOT IN ('draft', 'void')
         AND i.invoice_date >= $2 AND i.invoice_date <= $3

      UNION ALL

      SELECT cml.item_id,
             cm.date,
             to_char(cm.date, 'YYYY-MM'),
             'credit_memo'::text,
             cm.id,
             cm.credit_memo_number::text,
             cm.customer_id,
             cml.id,
             -cml.quantity::numeric,
             -(cml.quantity * cml.unit_price)::numeric(18,4),
             -(cml.quantity * COALESCE(cml.restock_unit_cost, 0))::numeric,
             0::numeric,
             (cml.restock_unit_cost IS NULL),
             (CASE WHEN cml.restock_unit_cost IS NULL THEN 'unknown' ELSE 'exact' END)::text
        FROM credit_memo_lines cml
        JOIN credit_memos cm ON cm.id = cml.credit_memo_id
       WHERE cm.company_id = $1 AND cml.item_id IS NOT NULL ${cm}
         AND cm.status <> 'void'
         AND cm.date >= $2 AND cm.date <= $3`;
  }

  /**
   * Per-item sales by month: `itemSalesLinesSql` grouped. Shared by
   * `itemPerformance` (one item, by month) and `inventoryPerformance` (every
   * item, one row each) so the two can never drift into reporting different
   * margins for the same sale.
   */
  private itemSalesUnionSql(byItem: boolean): string {
    return `
      SELECT l.item_id,
             l.period,
             SUM(l.units)::numeric(18,4)    AS units,
             SUM(l.revenue)::numeric(18,4)  AS revenue,
             SUM(l.cogs)::numeric(18,4)     AS cogs,
             SUM(l.est_cogs)::numeric(18,4) AS est_cogs,
             bool_or(l.cost_missing)        AS cost_missing
        FROM (${this.itemSalesLinesSql(byItem)}) l
       GROUP BY l.item_id, l.period`;
  }

  /**
   * One item's sales and gross margin, month by month, with what the item
   * explorer needs beside them: the item's own facts and who bought it.
   *
   * Revenue comes from invoice lines; cost comes from the per-line
   * `cost_amount` frozen at posting, plus the delivery branch, whose cost was
   * always frozen on `delivery_items` at dispatch.
   *
   * The two branches key on disjoint conditions — invoice lines with an
   * `item_id`, versus delivery items — so nothing is counted twice. Delivery
   * invoices carry no `item_id` on purpose: the stock left at dispatch, and a
   * non-null item_id is what makes posting relieve it a second time.
   *
   * `estimatedCogsShare` is the fraction of the period's cost that came from
   * apportioning a multi-item invoice's posted COGS across its lines. Each
   * invoice's total is exact; the split between different items on one invoice
   * is an estimate, and a margin built on a mostly-apportioned period is a
   * number nobody should act on. Reporting the share is what lets the reader
   * decide that for themselves.
   *
   * `item` and `customers` are additive: a client built before them reads the
   * rest of this response exactly as it did.
   */
  async itemPerformance(
    companyId: string,
    itemId: string,
    startDate: string,
    endDate: string,
  ) {
    const s = startDate || REPORT_RANGE_DEFAULTS.startDate;
    const e = endDate || REPORT_RANGE_DEFAULTS.endDate;

    const item = await this.findItemOrFail(companyId, itemId);

    const rows = await this.dataSource.query(
      `SELECT period, SUM(units) AS units, SUM(revenue) AS revenue,
              SUM(cogs) AS cogs, SUM(est_cogs) AS est_cogs,
              bool_or(cost_missing) AS cost_missing
         FROM (${this.itemSalesUnionSql(false)}) u
        GROUP BY period
        ORDER BY period`,
      [companyId, s, e, itemId],
    );

    const byPeriod = new Map<string, any>(rows.map((r: any) => [r.period as string, r]));

    // The window is the requested range, expressed as whole months, so a chart
    // keeps a fixed width rather than re-scaling as history accumulates.
    const months = Math.min(
      Math.max(monthSpan(s, e), 1),
      60,
    );
    const window = monthWindow(e === REPORT_RANGE_DEFAULTS.endDate ? businessToday() : e, months);

    const points = window.map((slot) => {
      const r = byPeriod.get(slot.period);
      const revenue = r2(num(r?.revenue));
      const cogs = r2(num(r?.cogs));
      const grossProfit = r2(revenue - cogs);
      return {
        period: slot.period,
        label: slot.label,
        unitsSold: r2(num(r?.units)),
        revenue,
        cogs,
        grossProfit,
        // Null rather than 0 on a month with no sales: a margin of zero is a
        // claim about a period that traded, not about one that did not.
        marginPct: revenue > 0 ? r2((grossProfit / revenue) * 100) : null,
        costKnown: !r?.cost_missing,
      };
    });

    const revenue = r2(points.reduce((t, p) => t + p.revenue, 0));
    const cogs = r2(points.reduce((t, p) => t + p.cogs, 0));
    const estCogs = r2(
      window.reduce((t, slot) => t + num(byPeriod.get(slot.period)?.est_cogs), 0),
    );
    const grossProfit = r2(revenue - cogs);

    // Who bought it in the range. Grouped over the same lines as the months
    // above, so the customers add up to the period's totals.
    const customerRows = await this.dataSource.query(
      `SELECT l.customer_id AS "customerId",
              COALESCE(c.name, '') AS "customerName",
              SUM(l.units)::numeric(18,4)   AS units,
              SUM(l.revenue)::numeric(18,4) AS revenue,
              SUM(l.cogs)::numeric(18,4)    AS cogs
         FROM (${this.itemSalesLinesSql(false)}) l
         LEFT JOIN customers c ON c.id = l.customer_id AND c.company_id = $1
        GROUP BY l.customer_id, c.name
        ORDER BY SUM(l.revenue) DESC, c.name`,
      [companyId, s, e, itemId],
    );
    const customers = customerRows.map((r: any) => {
      const rev = r2(num(r.revenue));
      return {
        customerId: r.customerId ?? null,
        customerName: r.customerName || '(no customer)',
        unitsSold: r2(num(r.units)),
        revenue: rev,
        grossProfit: r2(rev - num(r.cogs)),
      };
    });
    const top = customers.slice(0, TOP_CUSTOMERS);
    const rest = customers.slice(TOP_CUSTOMERS);

    // The horizon, and the last time the item sold at all — not just in this
    // range, because "not sold since March" is the answer to a range that is
    // empty. Returns are not sales here: taking stock back is not selling it.
    const [meta] = await this.dataSource.query(
      `SELECT (SELECT inventory_cost_history_from::text
                 FROM companies WHERE id = $1) AS since,
              (SELECT MAX(l.date)::text
                 FROM (${this.itemSalesLinesSql(false)}) l
                WHERE l.doc_type <> 'credit_memo') AS last_sold`,
      [
        companyId,
        REPORT_RANGE_DEFAULTS.startDate,
        REPORT_RANGE_DEFAULTS.endDate,
        itemId,
      ],
    );

    const qtyOnHand = num(item.quantityOnHand);
    const unitCost = num(item.unitCost);

    return {
      itemId: item.id,
      itemName: item.name,
      sku: item.sku,
      range: { startDate: s, endDate: e },
      points,
      totals: {
        unitsSold: r2(points.reduce((t, p) => t + p.unitsSold, 0)),
        revenue,
        cogs,
        grossProfit,
        marginPct: revenue > 0 ? r2((grossProfit / revenue) * 100) : null,
      },
      /** The first date from which cost is recorded. Null means never. */
      costHistoryFrom: toIsoDay(meta?.since),
      /** 0..1 — how much of the cost above is an apportioned estimate. */
      estimatedCogsShare: cogs > 0 ? r2(estCogs / cogs) : 0,
      /** The item as it stands today — stock figures are AS OF NOW. */
      item: {
        category: item.category || 'Uncategorized',
        unitOfMeasure: item.unitOfMeasure || 'unit',
        sellingPrice: r2(num(item.sellingPrice)),
        unitCost: r2(unitCost),
        qtyOnHand: r2(qtyOnHand),
        stockValue: r2(qtyOnHand * unitCost),
        reorderPoint: r2(num(item.reorderPoint)),
        isActive: item.isActive !== false,
        lastSoldDate: toIsoDay(meta?.last_sold),
      },
      customers: top,
      otherCustomers: {
        count: rest.length,
        unitsSold: r2(rest.reduce((t: number, c: any) => t + c.unitsSold, 0)),
        revenue: r2(rest.reduce((t: number, c: any) => t + c.revenue, 0)),
        grossProfit: r2(
          rest.reduce((t: number, c: any) => t + c.grossProfit, 0),
        ),
      },
    };
  }

  /**
   * The document lines behind one item's figures for a range — what the item
   * explorer lists under "What's behind March".
   *
   * Read from `itemSalesLinesSql`, the same rows `itemPerformance` groups by
   * month, so a month's entries add up to that month's point exactly. Newest
   * first and paginated: a year of a fast-moving item is every invoice it was
   * on. The page lives under `entries` — never `data`, which the response
   * envelope would lift out and discard `total` and `page` beside it.
   */
  async itemSalesEntries(
    companyId: string,
    itemId: string,
    startDate: string,
    endDate: string,
    page = 1,
    limit = 25,
  ) {
    const s = startDate || REPORT_RANGE_DEFAULTS.startDate;
    const e = endDate || REPORT_RANGE_DEFAULTS.endDate;
    const pageNo = Math.max(Math.trunc(page) || 1, 1);
    const size = Math.min(Math.max(Math.trunc(limit) || 25, 1), 100);

    const item = await this.findItemOrFail(companyId, itemId);
    const params = [companyId, s, e, itemId];

    const [sum] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(SUM(l.units), 0)::numeric(18,4)   AS units,
              COALESCE(SUM(l.revenue), 0)::numeric(18,4) AS revenue,
              COALESCE(SUM(l.cogs), 0)::numeric(18,4)    AS cogs
         FROM (${this.itemSalesLinesSql(false)}) l`,
      params,
    );

    const rows = await this.dataSource.query(
      `SELECT l.date::text AS date, l.doc_type AS "docType", l.doc_id AS "docId",
              l.doc_number AS "docNumber", l.customer_id AS "customerId",
              COALESCE(c.name, '') AS "customerName", l.line_id AS "lineId",
              l.units, l.revenue, l.cogs, l.cost_basis AS "costBasis",
              l.cost_missing AS "costMissing"
         FROM (${this.itemSalesLinesSql(false)}) l
         LEFT JOIN customers c ON c.id = l.customer_id AND c.company_id = $1
        ORDER BY l.date DESC, l.doc_number DESC, l.line_id
        LIMIT $5 OFFSET $6`,
      [...params, size, (pageNo - 1) * size],
    );

    const entries = rows.map((r: any) => {
      const units = r2(num(r.units));
      const revenue = r2(num(r.revenue));
      const cogs = r2(num(r.cogs));
      const grossProfit = r2(revenue - cogs);
      return {
        date: toIsoDay(r.date),
        docType: r.docType as 'invoice' | 'delivery' | 'credit_memo',
        docId: r.docId,
        docNumber: r.docNumber ?? '',
        customerId: r.customerId ?? null,
        customerName: r.customerName || '(no customer)',
        units,
        // What each unit went for, net of tax and discount — a return reads
        // at the price it was credited at, not as a negative price.
        unitPrice: units !== 0 ? r2(revenue / units) : 0,
        revenue,
        cogs,
        grossProfit,
        marginPct: revenue > 0 ? r2((grossProfit / revenue) * 100) : null,
        costBasis: r.costBasis ?? 'unknown',
        costKnown: r.costMissing !== true,
      };
    });

    const revenue = r2(num(sum?.revenue));
    const cogs = r2(num(sum?.cogs));
    return {
      itemId: item.id,
      range: { startDate: s, endDate: e },
      entries,
      total: Number(sum?.total ?? 0),
      page: pageNo,
      limit: size,
      totals: {
        unitsSold: r2(num(sum?.units)),
        revenue,
        cogs,
        grossProfit: r2(revenue - cogs),
      },
    };
  }


  /**
   * Every item's sales, cost and gross margin for a period, beside what it is
   * carrying in stock.
   *
   * One table answering both questions the Inventory Valuation report raises:
   * what is my money sitting in, and which of it actually earns. Stock figures
   * are AS OF NOW (they tie to balance-sheet 1200); revenue and margin cover
   * the requested period. The two are labelled separately on screen because
   * they are different claims about different moments.
   *
   * Items that sold nothing still appear, with zeros — dead stock is exactly
   * what this report exists to surface, and dropping it would hide the answer.
   *
   * ── On the reconciliation block ───────────────────────────────────────────
   * Per-item figures can never simply equal the P&L, because some of what sits
   * in revenue and COGS has no item dimension at all: service lines on
   * invoices, sales tax, manual journal entries, bills coded straight to COGS,
   * and purchase returns. Rather than let an accountant discover that as a
   * discrepancy and distrust the whole screen, the difference is named and
   * itemised. That is what makes this report investigable rather than merely
   * decorative.
   */
  async inventoryPerformance(
    companyId: string,
    startDate: string,
    endDate: string,
    sort: 'grossProfit' | 'revenue' | 'marginPct' | 'stockValue' = 'grossProfit',
  ) {
    const s = startDate || REPORT_RANGE_DEFAULTS.startDate;
    const e = endDate || REPORT_RANGE_DEFAULTS.endDate;

    const rows = await this.dataSource.query(
      `WITH sales AS (
         SELECT item_id,
                SUM(units)::numeric(18,4)   AS units,
                SUM(revenue)::numeric(18,4) AS revenue,
                SUM(cogs)::numeric(18,4)    AS cogs,
                SUM(est_cogs)::numeric(18,4) AS est_cogs,
                bool_or(cost_missing)       AS cost_missing
           FROM (${this.itemSalesUnionSql(true)}) u
          GROUP BY item_id
       )
       SELECT it.id AS "itemId", it.name AS "itemName", it.sku,
              COALESCE(it.category, 'Uncategorized') AS category,
              COALESCE(sa.units, 0)   AS units,
              COALESCE(sa.revenue, 0) AS revenue,
              COALESCE(sa.cogs, 0)    AS cogs,
              COALESCE(sa.est_cogs, 0) AS est_cogs,
              COALESCE(sa.cost_missing, false) AS cost_missing,
              it.quantity_on_hand AS "qtyOnHand",
              it.unit_cost        AS "unitCost"
         FROM inventory_items it
         LEFT JOIN sales sa ON sa.item_id = it.id
        WHERE it.company_id = $1`,
      [companyId, s, e],
    );

    // The last time each item sold at all, whatever the range — "not sold in
    // this period" is only half an answer without "since when". Returns are
    // not sales here: taking stock back is not selling it.
    const lastSoldRows = await this.dataSource.query(
      `SELECT l.item_id AS "itemId", MAX(l.date)::text AS "lastSold"
         FROM (${this.itemSalesLinesSql(true)}) l
        WHERE l.doc_type <> 'credit_memo'
        GROUP BY l.item_id`,
      [
        companyId,
        REPORT_RANGE_DEFAULTS.startDate,
        REPORT_RANGE_DEFAULTS.endDate,
      ],
    );
    const lastSold = new Map<string, string | null>(
      lastSoldRows.map((r: any) => [r.itemId as string, toIsoDay(r.lastSold)]),
    );

    const mapped = rows.map((r: any) => {
      const revenue = r2(num(r.revenue));
      const cogs = r2(num(r.cogs));
      const qty = num(r.qtyOnHand);
      const unitCost = num(r.unitCost);
      const grossProfit = r2(revenue - cogs);
      return {
        itemId: r.itemId,
        itemName: r.itemName,
        sku: r.sku,
        category: r.category,
        unitsSold: r2(num(r.units)),
        revenue,
        cogs,
        grossProfit,
        // Null, never 0, in a period the item did not trade: a margin of zero
        // is a claim about a period that sold something.
        marginPct: revenue > 0 ? r2((grossProfit / revenue) * 100) : null,
        qtyOnHand: r2(qty),
        unitCost: r2(unitCost),
        stockValue: r2(qty * unitCost),
        costBasis: r.cost_missing
          ? 'partial'
          : num(r.est_cogs) > 0
            ? 'apportioned'
            : 'posted',
        lastSoldDate: lastSold.get(r.itemId) ?? null,
      };
    });

    const key = sort;
    mapped.sort((a: any, b: any) => {
      // Nulls last whichever way the column sorts — an item that did not trade
      // has no margin, and floating it to the top would bury the ones that did.
      const av = a[key];
      const bv = b[key];
      if (av === null) return 1;
      if (bv === null) return -1;
      return bv - av;
    });

    const sum = (f: (x: any) => number) => r2(mapped.reduce((t: number, x: any) => t + f(x), 0));
    const revenue = sum((x) => x.revenue);
    const cogs = sum((x) => x.cogs);
    const estCogs = r2(rows.reduce((t: number, r: any) => t + num(r.est_cogs), 0));

    // What the ledger says, so the gap can be named rather than discovered.
    const [gl] = await this.dataSource.query(
      `SELECT
         COALESCE(SUM(CASE WHEN a.account_number = '4000'
                           THEN g.credit - g.debit ELSE 0 END), 0)::numeric(18,4) AS revenue,
         COALESCE(SUM(CASE WHEN a.account_number = '5000'
                           THEN g.debit - g.credit ELSE 0 END), 0)::numeric(18,4) AS cogs
         FROM general_ledger g
         JOIN accounts a ON a.id = g.account_id AND a.company_id = g.company_id
        WHERE g.company_id = $1 AND a.account_number IN ('4000', '5000')
          AND g.date >= $2 AND g.date <= $3`,
      [companyId, s, e],
    );

    const glRevenue = r2(num(gl?.revenue));
    const glCogs = r2(num(gl?.cogs));

    // The control account the stock column should agree with. All-time, like
    // the snapshot beside it: quantity on hand reflects every posting, dated
    // or not, so a date cut here would compare two different moments. The
    // screen shows the difference rather than letting a drift go unseen —
    // it is the I13 invariant, surfaced where someone can act on it.
    const [ledger] = await this.dataSource.query(
      `SELECT COALESCE(SUM(g.debit - g.credit), 0)::numeric(18,4) AS value
         FROM general_ledger g
         JOIN accounts a ON a.id = g.account_id AND a.company_id = g.company_id
        WHERE g.company_id = $1 AND a.account_number = '1200'`,
      [companyId],
    );

    // Name the difference instead of leaving it as one unexplained lump.
    //
    // Decomposing revenue and cost by the document that posted them shows which
    // parts could never belong to an item: a manual journal entry against
    // revenue, a bill coded straight to cost of sales, goods sent back to a
    // supplier. Whatever those do not account for is sales tax and service
    // lines, which is the residual — so the block always foots exactly rather
    // than nearly.
    const srcRows = await this.dataSource.query(
      `SELECT a.account_number AS acct, g.source_type AS src,
              SUM(CASE WHEN a.account_number = '4000'
                       THEN g.credit - g.debit ELSE g.debit - g.credit END)::numeric(18,4) AS net
         FROM general_ledger g
         JOIN accounts a ON a.id = g.account_id AND a.company_id = g.company_id
        WHERE g.company_id = $1 AND a.account_number IN ('4000', '5000')
          AND g.date >= $2 AND g.date <= $3
        GROUP BY a.account_number, g.source_type`,
      [companyId, s, e],
    );

    const netOf = (acct: string, types: string[]) =>
      r2(
        srcRows
          .filter((r: any) => r.acct === acct && types.includes(r.src))
          .reduce((t: number, r: any) => t + num(r.net), 0),
      );

    const manualRevenue = netOf('4000', ['journal_entry', 'opening_balance']);
    const supplierReturns = netOf('5000', ['vendor_credit', 'vendor_credit_void']);

    const unallocatedRevenue = r2(glRevenue - revenue);
    const unallocatedCogs = r2(glCogs - cogs);

    const reconcilingItems = [
      {
        label: 'Sales tax and non-stock lines',
        revenue: r2(unallocatedRevenue - manualRevenue),
        cogs: 0,
        reason:
          'Tax is collected, not earned, and a service or delivery charge on an invoice belongs to no item.',
      },
      {
        label: 'Manual journal entries',
        revenue: manualRevenue,
        cogs: 0,
        reason: 'Posted straight to the account with no document behind them.',
      },
      {
        label: 'Supplier returns',
        revenue: 0,
        cogs: supplierReturns,
        reason:
          'Goods sent back to a supplier reduce cost of sales in the ledger, but they are not the cost of anything sold — counting them against an item would flatter its margin.',
      },
      {
        label: 'Costs billed directly',
        revenue: 0,
        cogs: r2(unallocatedCogs - supplierReturns),
        reason:
          'Bills coded straight to cost of sales. Bill lines carry an account, not an item.',
      },
    ].filter((x) => Math.abs(x.revenue) > 0.005 || Math.abs(x.cogs) > 0.005);

    const [company] = await this.dataSource.query(
      `SELECT inventory_cost_history_from::text AS since FROM companies WHERE id = $1`,
      [companyId],
    );

    return {
      range: { startDate: s, endDate: e },
      sort,
      rows: mapped,
      totals: {
        unitsSold: sum((x) => x.unitsSold),
        revenue,
        cogs,
        grossProfit: r2(revenue - cogs),
        marginPct: revenue > 0 ? r2(((revenue - cogs) / revenue) * 100) : null,
        stockValue: sum((x) => x.stockValue),
        /** GL 1200, all time — what `stockValue` should equal. */
        ledgerValue: r2(num(ledger?.value)),
      },
      reconciliation: {
        glRevenue,
        glCogs,
        itemRevenue: revenue,
        itemCogs: cogs,
        // Named, not hidden. Everything the ledger holds that no item can own:
        // service lines, sales tax, manual entries against revenue, bills coded
        // straight to COGS, and purchase returns.
        unallocatedRevenue,
        unallocatedCogs,
        // Itemised, and it foots: the first entry is a residual, so
        // itemRevenue + sum(items.revenue) = glRevenue exactly, and likewise
        // for cost. Nothing is hand-waved.
        items: reconcilingItems,
        note:
          'Per-item figures cover goods sold. The difference from the Profit & Loss is ' +
          'listed above — none of it belongs to a single item.',
      },
      estimatedCogsShare: cogs > 0 ? r2(estCogs / cogs) : 0,
      costHistoryFrom: company?.since ?? null,
    };
  }

  // ── Delivery Daily ───────────────────────────────────────────────
  async deliveryDaily(companyId: string) {
    const deliveries = await this.dataSource.query(
      `SELECT d.status, d.personnel_id AS "personnelId", d.zone, u.display_name AS "personnelName"
       FROM deliveries d LEFT JOIN users u ON u.id = d.personnel_id WHERE d.company_id=$1`, [companyId]);
    const total = deliveries.length;
    const completed = deliveries.filter((d: any) => d.status === 'delivered').length;
    const failed = deliveries.filter((d: any) => d.status === 'failed').length;
    const onTimePercent = total > 0 ? r2((completed / total) * 100) : 0;

    const pMap = new Map<string, any>();
    for (const d of deliveries) {
      if (!d.personnelId) continue;
      if (!pMap.has(d.personnelId)) pMap.set(d.personnelId, { personId: d.personnelId, name: d.personnelName ?? 'Unassigned', total: 0, delivered: 0, failed: 0, onTimeRate: 0 });
      const e = pMap.get(d.personnelId);
      e.total++;
      if (d.status === 'delivered') e.delivered++;
      if (d.status === 'failed') e.failed++;
    }
    const personnelStats = Array.from(pMap.values()).map((e) => ({ ...e, onTimeRate: e.total > 0 ? r2((e.delivered / e.total) * 100) : 0 }));

    const zMap = new Map<string, number>();
    for (const d of deliveries) { const z = d.zone ?? 'Unassigned'; zMap.set(z, (zMap.get(z) ?? 0) + 1); }
    const agencyDistribution = Array.from(zMap.entries()).map(([z, count]) => ({ agencyId: z, agencyName: z, count }));

    return { date: new Date().toISOString().slice(0, 10), total, completed, failed, onTimePercent, personnelStats, agencyDistribution };
  }

  // ── Delivery Performance ─────────────────────────────────────────
  async deliveryPerformance(companyId: string) {
    const daily = await this.deliveryDaily(companyId);
    const rows = daily.personnelStats;
    // Build a 7-day trend from delivery completion/created dates
    const trendRaw = await this.dataSource.query(
      `SELECT COALESCE(to_char(d.completed_at,'Dy'), to_char(d.created_at,'Dy')) AS label,
              SUM(CASE WHEN d.status='delivered' THEN 1 ELSE 0 END) AS delivered,
              SUM(CASE WHEN d.status='failed' THEN 1 ELSE 0 END) AS failed
       FROM deliveries d WHERE d.company_id=$1
       GROUP BY label`, [companyId]);
    const dailyTrend = trendRaw.map((t: any) => ({ label: (t.label ?? '').trim() || '—', delivered: parseInt(t.delivered, 10) || 0, failed: parseInt(t.failed, 10) || 0 }));
    return { rows, dailyTrend };
  }

  // ── Analytics Dashboard ──────────────────────────────────────────
  async analyticsDashboard(companyId: string) {
    const revRows = await this.dataSource.query(
      `SELECT EXTRACT(YEAR FROM invoice_date::date)::int AS yr, EXTRACT(MONTH FROM invoice_date::date)::int AS mo, SUM(total::numeric) AS v
       FROM invoices WHERE company_id=$1 AND status NOT IN ('void','draft') GROUP BY yr, mo ORDER BY yr, mo`, [companyId]);
    const billRows = await this.dataSource.query(
      `SELECT EXTRACT(YEAR FROM bill_date::date)::int AS yr, EXTRACT(MONTH FROM bill_date::date)::int AS mo, SUM(total::numeric) AS v
       FROM bills WHERE company_id=$1 AND status NOT IN ('void','draft') GROUP BY yr, mo ORDER BY yr, mo`, [companyId]);
    const revenueTrend = revRows.slice(-12).map((r: any) => ({ label: `${MONTH_LABELS[r.mo - 1]} ${String(r.yr).slice(2)}`, value: r2(num(r.v)) }));
    const billByKey = new Map<string, number>();
    for (const b of billRows) billByKey.set(`${b.yr}-${b.mo}`, num(b.v));
    const cashFlowTrend = revRows.slice(-12).map((r: any) => ({ label: `${MONTH_LABELS[r.mo - 1]} ${String(r.yr).slice(2)}`, value: r2(num(r.v) - (billByKey.get(`${r.yr}-${r.mo}`) ?? 0)) }));

    const expRows = await this.dataSource.query(
      `SELECT v.company_name AS label, SUM(b.total::numeric) AS value FROM bills b JOIN vendors v ON v.id=b.vendor_id
       WHERE b.company_id=$1 AND b.status NOT IN ('void','draft') GROUP BY v.company_name ORDER BY value DESC`, [companyId]);
    const expenseCategories = expRows.map((e: any) => ({ label: e.label, value: r2(num(e.value)) }));

    const custRows = await this.dataSource.query(
      `SELECT c.name AS label, SUM(i.total::numeric) AS value FROM invoices i JOIN customers c ON c.id=i.customer_id
       WHERE i.company_id=$1 AND i.status NOT IN ('void','draft') GROUP BY c.name ORDER BY value DESC LIMIT 5`, [companyId]);
    const topCustomers = custRows.map((c: any) => ({ label: c.label, value: r2(num(c.value)) }));

    const aging = await this.arAging(companyId);
    const arAgingTrend = [{
      label: 'Current',
      current: aging.totals.current,
      bucket1to30: aging.totals.bucket1to30,
      bucket31to60: aging.totals.bucket31to60,
      bucket61to90: aging.totals.bucket61to90,
      bucket90Plus: aging.totals.bucket90Plus,
    }];

    return { revenueTrend, expenseCategories, cashFlowTrend, topCustomers, arAgingTrend };
  }

  // ── Simple delivery status breakdown (legacy endpoint) ───────────
  async deliveryReport(companyId: string, startDate: string, endDate: string) {
    const qb = this.deliveryRepo.createQueryBuilder('d')
      .select('d.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('d.companyId = :cid', { cid: companyId })
      .groupBy('d.status');
    return qb.getRawMany();
  }

  async aging(companyId: string, request?: AgingSpecRequest & { type?: 'ar' | 'ap' }) {
    return request?.type === 'ap'
      ? this.apAging(companyId, request)
      : this.arAging(companyId, request);
  }

  // ── Admin home dashboard summary ─────────────────────────────────
  async dashboardSummary(companyId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().slice(0, 10);
    const monthEnd = now.toISOString().slice(0, 10);

    const invoiceTotal = await this.sum('invoices', 'total', companyId, 'invoice_date', monthStart, monthEnd);
    const billTotal = await this.sum('bills', 'total', companyId, 'bill_date', monthStart, monthEnd);
    const outstandingAR = (await this.dataSource.query(
      `SELECT COALESCE(SUM(balance::numeric),0) AS v FROM invoices WHERE company_id=$1 AND status NOT IN ('paid','void')`, [companyId]))[0]?.v;
    // What we owe suppliers, reconciled to account 2000.
    //
    // Two corrections to what this used to be. DRAFT bills post no journal
    // entry at all, so counting them showed money that does not exist in the
    // ledger and never cleared (apAging already excludes them — this was an
    // inconsistency, not a judgement). And an unapplied vendor credit has
    // already been debited to A/P, so the gross bill balances overstate the
    // liability until the credit is applied to a specific bill.
    const pendingAP = (await this.dataSource.query(
      `SELECT GREATEST(
                COALESCE((SELECT SUM(balance::numeric) FROM bills
                           WHERE company_id=$1 AND status NOT IN ('paid','void','draft')), 0)
              - COALESCE((SELECT SUM(balance::numeric) FROM vendor_credits
                           WHERE company_id=$1 AND status NOT IN ('void','closed')), 0),
              0) AS v`, [companyId]))[0]?.v;
    const itemCount = await this.itemRepo.count({ where: { companyId } });
    const deliveryStats = await this.deliveryRepo.createQueryBuilder('d')
      .select('d.status', 'status').addSelect('COUNT(*)', 'count')
      .where('d.companyId = :cid', { cid: companyId }).groupBy('d.status').getRawMany();
    const recentInvoices = await this.invoiceRepo.createQueryBuilder('i')
      .where('i.companyId = :cid', { cid: companyId }).orderBy('i.invoiceDate', 'DESC').limit(5).getMany();
    const recentBills = await this.billRepo.createQueryBuilder('b')
      .where('b.companyId = :cid', { cid: companyId }).orderBy('b.billDate', 'DESC').limit(5).getMany();

    const deliveryBreakdown: Record<string, number> = { pending: 0, assigned: 0, in_transit: 0, delivered: 0, failed: 0, cancelled: 0, unassigned: 0 };
    let deliveryTotal = 0;
    for (const row of deliveryStats) { deliveryBreakdown[row.status] = parseInt(row.count, 10); deliveryTotal += parseInt(row.count, 10); }

    const recentTransactions = [
      ...recentInvoices.map((inv) => ({ id: inv.id, type: 'invoice' as const, description: inv.invoiceNumber, date: inv.invoiceDate, amount: num(inv.total), status: inv.status })),
      ...recentBills.map((bill) => ({ id: bill.id, type: 'bill' as const, description: bill.billNumber, date: bill.billDate, amount: num(bill.total), status: bill.status })),
    ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 8);

    const overdueInvoicesCount = recentInvoices.filter((inv) => inv.status !== 'paid' && inv.status !== 'void' && new Date(inv.dueDate) < now).length;
    const alerts: { id: string; message: string; severity: 'red' | 'amber' | 'blue' }[] = [];
    if (overdueInvoicesCount > 0) alerts.push({ id: 'overdue', message: `${overdueInvoicesCount} overdue invoice(s) require attention.`, severity: 'red' });
    if (num(pendingAP) > 0) alerts.push({ id: 'pending_bills', message: `You have pending bills totalling Rs ${num(pendingAP).toLocaleString()}.`, severity: 'amber' });
    if (deliveryBreakdown.pending > 0) alerts.push({ id: 'pending_delivery', message: `${deliveryBreakdown.pending} delivery order(s) awaiting assignment.`, severity: 'blue' });

    const setup = await this.setupStatus(companyId, itemCount);

    return {
      totalRevenue: invoiceTotal,
      totalExpenses: billTotal,
      outstandingAR: num(outstandingAR),
      pendingAP: num(pendingAP),
      inventoryItems: itemCount,
      deliveryBreakdown,
      deliveryTotal,
      recentTransactions,
      alerts,
      setup,
      period: { startDate: monthStart, endDate: monthEnd },
    };
  }

  /**
   * Guided first-run setup signals (FinMatrixGuide §5.7). Each step's `done`
   * reflects whether the underlying data exists; `completed` is the company's
   * dismiss/finish flag. Surfaced on the dashboard so the checklist can show or
   * hide itself. Purely informational — no accounting logic here.
   */
  private async setupStatus(companyId: string, itemCount: number) {
    const count1 = async (sql: string) =>
      parseInt((await this.dataSource.query(sql, [companyId]))[0]?.v ?? '0', 10);

    const openingBalance = await count1(
      `SELECT CASE WHEN
         EXISTS (SELECT 1 FROM general_ledger WHERE company_id=$1 AND source_type='opening_balance')
         OR EXISTS (SELECT 1 FROM accounts WHERE company_id=$1 AND opening_balance::numeric <> 0)
       THEN 1 ELSE 0 END AS v`,
    );
    const customAccounts = await count1(
      `SELECT COUNT(*) v FROM accounts WHERE company_id=$1`,
    );
    const customers = await count1(`SELECT COUNT(*) v FROM customers WHERE company_id=$1`);
    const vendors = await count1(`SELECT COUNT(*) v FROM vendors WHERE company_id=$1`);
    const taxRates = await count1(`SELECT COUNT(*) v FROM tax_rates WHERE company_id=$1`);
    const company = await this.dataSource.query(
      `SELECT setup_completed AS "v" FROM companies WHERE id=$1`,
      [companyId],
    );

    const steps = {
      openingBalance: openingBalance > 0,
      chartOfAccounts: customAccounts > 0,
      inventory: itemCount > 0,
      customers: customers > 0,
      vendors: vendors > 0,
      taxRates: taxRates > 0,
    };
    return {
      completed: company[0]?.v === true,
      steps,
    };
  }

  // ── Trial Balance (derived; ties to Balance Sheet + P&L) ─────────
  // Debits = Cash + AR + Inventory + COGS + OpEx
  // Credits = AP + Sales Revenue + Opening Equity
  // Opening Equity is back-solved so the sheet balances and closing equity
  // (opening + net income) equals the Balance Sheet equity.
  // ── Trial Balance (ledger-derived) ───────────────────────────────
  async trialBalance(companyId: string, startDate: string, endDate: string) {
    const s = startDate || REPORT_RANGE_DEFAULTS.startDate;
    const e = endDate || REPORT_RANGE_DEFAULTS.endDate;
    const glRows = await this.glByAccount(companyId, s, e);

    // Each account's net (debits − credits) lands in its natural column. Since
    // every posted entry is balanced, Σ net across accounts is 0, so the column
    // totals are equal — the trial balance always balances to the paisa.
    const nets = glRows.map((row) => ({
      accountCode: row.accountNumber,
      accountName: row.accountName,
      net: num(row.dr) - num(row.cr),
    }));

    const rows = nets
      .map((a) => ({
        accountCode: a.accountCode,
        accountName: a.accountName,
        debit: a.net >= 0 ? r2(a.net) : 0,
        credit: a.net < 0 ? r2(-a.net) : 0,
      }))
      .filter((row) => row.debit > 0 || row.credit > 0);

    // Foot the columns from the UNROUNDED nets, then round once.
    //
    // That claim above only holds at full precision. Summing the ROUNDED
    // column values instead — which is what this did — breaks it, because
    // Σ round(x) is not round(Σ x): the ledger carries four decimals, so every
    // account can hide up to half a paisa, and across thirty-odd accounts the
    // two columns drift apart. A trial balance whose columns do not foot is
    // not a trial balance, however small the gap. The rows keep their rounded
    // figures for presentation; only the totals are computed at full precision.
    //
    // Decide BALANCED before rounding, and round once afterwards.
    //
    // Rounding first reintroduces the same class of bug one step later. The two
    // columns are summed from different sets of floats in different orders, so
    // they carry different accumulated error — normally far below a paisa, but
    // when the true total sits exactly on a half-paisa boundary the two land on
    // OPPOSITE sides of it and round a full paisa apart. Warehouse Co hit this
    // for real at 1,288,526.5650: a ledger balanced to the last unit in the
    // database reported Dr …56 against Cr …57 and isBalanced: false.
    //
    // Telling a business its books do not balance when they do is worse than
    // most genuine defects — it sends someone hunting for an error that was
    // never posted. So the verdict is taken at full precision, and when the
    // columns agree there they are PRESENTED as the single number they are.
    // A real imbalance still prints both sides, unrounded-truth intact.
    const rawDebits = nets.reduce((a, x) => (x.net > 0 ? a + x.net : a), 0);
    const rawCredits = nets.reduce((a, x) => (x.net < 0 ? a - x.net : a), 0);
    const isBalanced = Math.abs(rawDebits - rawCredits) < 0.01;
    const totalDebits = r2(rawDebits);
    const totalCredits = isBalanced ? totalDebits : r2(rawCredits);
    return {
      range: { startDate: s, endDate: e },
      rows,
      totalDebits,
      totalCredits,
      isBalanced,
    };
  }

  // ── Cash Flow Statement (period, ledger-derived direct method) ───
  // Derived from the actual posted ledger movements on the Cash/Bank accounts,
  // by the date the cash truly moved. A customer payment therefore lands on its
  // payment date (not the invoice date), a bill payment on its payment date,
  // and tax/payroll/manual cash entries are all captured automatically. This is
  // the QuickBooks "direct method" and ties exactly to the Balance Sheet cash
  // (FinMatrixGuide §5.4): ending cash == Σ(debit − credit) on cash accounts
  // through endDate.
  async cashFlow(
    companyId: string,
    startDate: string,
    endDate: string,
  ): Promise<CashFlowReport> {
    const s = startDate || REPORT_RANGE_DEFAULTS.startDate;
    const e = endDate || reportToday();

    // Cash/Bank accounts (sub_type), so custom user-added bank accounts count too.
    const cashFilter = `a.sub_type IN ('Cash','Bank')`;

    // Beginning cash = net cash movement on cash/bank accounts before the period.
    const beginRows = await this.dataSource.query(
      `SELECT COALESCE(SUM(g.debit::numeric - g.credit::numeric),0) AS v
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id=$1 AND ${cashFilter} AND g.date < $2`,
      [companyId, s],
    );
    const beginningCash = r2(num(beginRows[0]?.v));

    // In-period cash movement grouped by the source document type. This is the
    // DIRECT method: useful internally because every line traces to a document
    // type. It is NOT what QuickBooks Online publishes — QBO's built-in
    // Statement of Cash Flows is the INDIRECT one, built below.
    const srcRows = await this.dataSource.query(
      `SELECT g.source_type AS src,
              COALESCE(SUM(g.debit::numeric),0)  AS inflow,
              COALESCE(SUM(g.credit::numeric),0) AS outflow
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id=$1 AND ${cashFilter} AND g.date >= $2 AND g.date <= $3
        GROUP BY g.source_type`,
      [companyId, s, e],
    );

    // source_type → statement line + section. Unmapped types fall into
    // operating "Other cash movements" so the statement always ties out.
    type Section = 'operating' | 'investing' | 'financing';
    const META: Record<string, { label: string; section: Section }> = {
      payment: { label: 'Cash received from customers', section: 'operating' },
      invoice: { label: 'Cash received from customers', section: 'operating' },
      credit_memo: { label: 'Customer refunds', section: 'operating' },
      credit_memo_refund: { label: 'Customer refunds', section: 'operating' },
      bill_payment: { label: 'Cash paid to suppliers', section: 'operating' },
      bill: { label: 'Cash paid to suppliers', section: 'operating' },
      vendor_credit: { label: 'Vendor refunds received', section: 'operating' },
      payroll: { label: 'Payroll paid', section: 'operating' },
      tax_payment: { label: 'Tax payments', section: 'operating' },
      opening_balance: { label: 'Opening balance / owner funding', section: 'financing' },
      journal_entry: { label: 'Other cash movements', section: 'operating' },
    };

    const buckets: Record<Section, Map<string, number>> = {
      operating: new Map(),
      investing: new Map(),
      financing: new Map(),
    };
    for (const row of srcRows) {
      const net = num(row.inflow) - num(row.outflow);
      if (Math.abs(net) < 0.005) continue;
      const meta = META[row.src as string] ?? { label: 'Other cash movements', section: 'operating' as Section };
      const bucket = buckets[meta.section];
      bucket.set(meta.label, (bucket.get(meta.label) ?? 0) + net);
    }

    const toSection = (m: Map<string, number>) => {
      const lines = Array.from(m.entries())
        .map(([label, amount]) => ({ label, amount: r2(amount) }))
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
      return { lines, total: r2(lines.reduce((t, l) => t + l.amount, 0)) };
    };
    const operating = toSection(buckets.operating);
    const investing = toSection(buckets.investing);
    const financing = toSection(buckets.financing);

    const netChange = r2(operating.total + investing.total + financing.total);
    const endingCash = r2(beginningCash + netChange);

    // Monthly net-cash trend within range.
    const trendRows = await this.dataSource.query(
      `SELECT EXTRACT(YEAR FROM g.date)::int AS yr, EXTRACT(MONTH FROM g.date)::int AS mo,
              COALESCE(SUM(g.debit::numeric - g.credit::numeric),0) AS v
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id=$1 AND ${cashFilter} AND g.date >= $2 AND g.date <= $3
        GROUP BY yr, mo ORDER BY yr, mo`,
      [companyId, s, e],
    );
    const monthlyTrend = trendRows.slice(-12).map((r: any) => ({
      label: `${MONTH_LABELS[r.mo - 1]} ${String(r.yr).slice(2)}`,
      value: r2(num(r.v)),
    }));

    const operatingIndirect = await this.buildOperatingIndirect(
      companyId,
      s,
      e,
      operating.total,
    );

    return {
      range: { startDate: s, endDate: e },
      operating,
      investing,
      financing,
      netChange,
      beginningCash,
      endingCash,
      monthlyTrend,
      operatingIndirect,
    };
  }

  /**
   * Indirect operating reconciliation — the presentation QuickBooks Online
   * publishes: start at net income, add back non-cash charges, then adjust for
   * the working capital that moved without cash following it.
   *
   * The two methods are the same number by construction: direct operating is
   * total cash movement less investing and financing, and the indirect walk
   * reaches the same place from the accrual side. Rather than trust that, the
   * residual against the direct total is measured and, if anything is left,
   * carried on an explicit "Other operating adjustments" line — the statement
   * always ties AND always shows what could not be attributed.
   *
   * Reads only; nothing here posts.
   */
  private async buildOperatingIndirect(
    companyId: string,
    s: string,
    e: string,
    directOperatingTotal: number,
  ): Promise<OperatingIndirect> {
    // The opening side is the day BEFORE the period starts, so the first day's
    // activity counts as movement.
    const dayBefore = new Date(`${s}T00:00:00Z`);
    dayBefore.setUTCDate(dayBefore.getUTCDate() - 1);
    const [openingBal, closingBal, periodRows] = await Promise.all([
      this.balancesAsOf(companyId, dayBefore.toISOString().slice(0, 10)),
      this.balancesAsOf(companyId, e),
      this.glByAccount(companyId, s, e),
    ]);

    const netIncome = this.netIncomeFrom(periodRows);

    const delta = (
      pick: (code: string, meta: { type: string; subType: string }) => boolean,
    ): number => {
      let d = 0;
      for (const [code, meta] of closingBal) {
        if (pick(code, meta))
          d += meta.balance - (openingBal.get(code)?.balance ?? 0);
      }
      return d;
    };

    const isCashLike = (m: { subType: string }) =>
      m.subType === 'Cash' || m.subType === 'Bank';
    const inRange = (code: string, lo: number, hi: number) => {
      const n = parseInt(code, 10);
      return Number.isFinite(n) && n >= lo && n <= hi;
    };

    // 1250 sits INSIDE 1200–1299, so Inventory excludes it explicitly —
    // counting Goods in Transit in both would double the adjustment. Same for
    // GRNI 2050, excluded from other liabilities.
    const dAR = delta(
      (_c, m) => m.type === 'asset' && m.subType === 'Accounts Receivable',
    );
    const dInventory = delta(
      (c, m) => m.type === 'asset' && inRange(c, 1200, 1299) && c !== '1250',
    );
    const dGit = delta((c) => c === '1250');
    const dOtherAssets = delta(
      (c, m) =>
        m.type === 'asset' &&
        !isCashLike(m) &&
        m.subType !== 'Accounts Receivable' &&
        !inRange(c, 1200, 1299),
    );
    const dAP = delta(
      (_c, m) => m.type === 'liability' && m.subType === 'Accounts Payable',
    );
    const dGrni = delta((c) => c === '2050');
    const dOtherLiabs = delta(
      (c, m) =>
        m.type === 'liability' &&
        m.subType !== 'Accounts Payable' &&
        c !== '2050',
    );
    const depreciation = delta(
      (_c, m) => m.type === 'expense' && m.subType === 'Depreciation',
    );

    // An asset going UP consumes cash; a liability going UP releases it.
    const candidates: CashFlowLine[] = [
      { label: 'Depreciation & amortisation', amount: depreciation },
      { label: 'Accounts Receivable', amount: -dAR },
      { label: 'Inventory', amount: -dInventory },
      { label: 'Goods in Transit', amount: -dGit },
      { label: 'Other current assets', amount: -dOtherAssets },
      { label: 'Accounts Payable', amount: dAP },
      { label: 'Goods Received Not Invoiced', amount: dGrni },
      { label: 'Other current liabilities', amount: dOtherLiabs },
    ];

    const adjustments = candidates
      .filter((l) => Math.abs(l.amount) > 0.005)
      .map((l) => ({ label: l.label, amount: r2(l.amount) }));

    const subtotal = r2(
      netIncome + adjustments.reduce((t, l) => t + l.amount, 0),
    );
    const residual = r2(directOperatingTotal - subtotal);
    if (Math.abs(residual) > 0.005) {
      adjustments.push({
        label: 'Other operating adjustments',
        amount: residual,
      });
    }

    return { netIncome, adjustments, total: r2(directOperatingTotal) };
  }

  toCsv(rows: Record<string, unknown>[]): string {
    if (!rows.length) return '';
    const keys = Object.keys(rows[0]);
    const header = keys.join(',');
    const lines = rows.map((r) => keys.map((k) => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','));
    return [header, ...lines].join('\n');
  }
}
