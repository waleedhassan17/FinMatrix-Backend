import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
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
  BalanceSheetLine,
  BalanceSheetReport,
  BalanceSheetSection,
  BalanceSheetSubtotal,
  CashFlowAccount,
  CashFlowMonth,
  CashFlowLine,
  CashFlowReport,
  OperatingIndirect,
  PnlLine,
  ProfitLossReport,
  TrialBalanceMode,
} from './reports.types';
import {
  clampMonth,
  dayBefore,
  fiscalYearEndOf,
  fiscalYearStart,
  fiscalYearStartOf,
  precedingPeriod,
} from './fiscal-year';
import {
  PNL_GROUPS,
  STATEMENT_GROUPS,
  accountGroupFor,
  classifyForStatement,
  groupLabel,
  isCogsAccount,
  isNonOperatingAccount,
  type StatementGroupKey,
} from './statement-groups';
import {
  CASH_FLOW_LINES,
  EPS,
  cashRowShare,
  OPENING_SOURCE_TYPES,
  classifyPosting,
  isCashFlowLineKey,
  nonCashShares,
  type CashFlowLineKey,
  type CashFlowSectionKey,
  type LedgerRow,
  type LookThroughWeight,
  type Posting,
  type PostingCashFlow,
} from './cash-flow-classify';
import {
  AgingBucketSpecError,
  LEGACY_BOUNDARIES,
  bucketKeyFor,
  buildBucketSpec,
  resolveAgingSpec,
  type AgingBucketDef,
  type AgingSpecRequest,
  type ResolvedAgingSpec,
} from './aging-buckets';
import { assessKpi } from './kpi-benchmarks';
import { OUTBOUND_SQL } from './inventory-movement-rules';
import {
  daysOfCover,
  isDeadStock,
  itemStockStatus,
  suggestedOrderQty,
} from './item-stock';
import { MediaUrlSigner } from '../inventory/images/media-url.signer';
import {
  businessTimezone,
  businessToday,
  daysBetweenIso,
} from '../../common/utils/business-date.util';
import { buildDashboardAlerts } from './dashboard-alerts';
import { MONEY_TOLERANCE } from '../../common/utils/money.util';
import {
  UNAPPLIED_RECEIPTS_SQL,
  type UnappliedReceiptRow,
} from '../payments/unapplied-receipts.sql';

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Round figures so the ROUNDED values add up to `target` exactly (largest
 * remainder): each is rounded, then the paisa the rounding lost or gained are
 * handed to the figures whose rounding moved them furthest.
 *
 * For a breakdown whose parts are shown beside their total — a monthly series
 * beside the period figure, adjustments beside the operating total. The total
 * itself is still rounded ONCE from the raw sum; this only decides how its
 * parts are presented so that a printed column foots. A gap wider than one
 * paisa per part is not rounding, so it is left alone for the caller to see.
 */
export function apportionRounding(raws: number[], target: number): number[] {
  const rounded = raws.map(r2);
  let paisa = Math.round((target - rounded.reduce((t, x) => t + x, 0)) * 100);
  if (paisa === 0 || !raws.length || Math.abs(paisa) > raws.length)
    return rounded;
  const step = paisa > 0 ? 1 : -1;
  const order = raws
    .map((raw, i) => ({ i, err: raw - rounded[i] }))
    .sort((a, b) => (step > 0 ? b.err - a.err : a.err - b.err));
  for (let k = 0; paisa !== 0; k++) {
    const i = order[k % order.length].i;
    rounded[i] = r2(rounded[i] + step / 100);
    paisa -= step;
  }
  return rounded;
}

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

/**
 * One customer's open invoices, soonest due first — in the same order the
 * server applies a receipt oldest-first (InvoicesService.outstandingForCustomer:
 * due date, then invoice date, then number), so a split previewed from the
 * summary is the split the server would make. `$1` company, `$2` customer.
 */
const OPEN_INVOICES_SQL = `
  SELECT i.id AS "documentId", i.invoice_number AS "documentNumber",
         i.invoice_date::text AS "issueDate", i.due_date::text AS "dueDate",
         i.total::numeric AS total, i.amount_paid::numeric AS "amountPaid",
         i.balance::numeric AS balance, i.status
    FROM invoices i
   WHERE i.company_id = $1 AND i.customer_id = $2 AND ${openDocPredicate('i')}
   ORDER BY i.due_date ASC, i.invoice_date ASC, i.invoice_number ASC, i.id ASC`;

/** One vendor's open bills, soonest due first. `$1` company, `$2` vendor. */
const OPEN_BILLS_SQL = `
  SELECT b.id AS "documentId", b.bill_number AS "documentNumber",
         b.bill_date::text AS "issueDate", b.due_date::text AS "dueDate",
         b.total::numeric AS total, b.amount_paid::numeric AS "amountPaid",
         b.balance::numeric AS balance, b.status
    FROM bills b
   WHERE b.company_id = $1 AND b.vendor_id = $2 AND ${openDocPredicate('b')}
   ORDER BY b.due_date ASC, b.bill_date ASC, b.bill_number ASC, b.id ASC`;

/** An open invoice or bill, aged against today. */
export interface OpenAgingDocument {
  documentId: string;
  documentType: 'invoice' | 'bill';
  documentNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  /** Signed: below zero is "due in N days". */
  daysOverdue: number;
  bucketKey: string;
  bucketLabel: string;
  total: number;
  amountPaid: number;
  balance: number;
  status: string;
}

/**
 * Money on a party's account that no document has used yet: an unapplied
 * customer receipt, an open credit memo, or an open vendor credit.
 */
export interface PartyCredit {
  kind: 'payment' | 'credit_memo' | 'vendor_credit';
  id: string;
  reference: string | null;
  date: string | null;
  amount: number;
  /** What is left to apply — the part that reduces what is due. */
  available: number;
}

/** Summed from the rounded balances, so a printed column foots to its total. */
const sumBalances = (docs: OpenAgingDocument[]): number =>
  r2(docs.reduce((t, d) => t + d.balance, 0));

/** A stored address (jsonb) as one line; null when it holds nothing. */
const addressLine = (a: any): string | null => {
  if (!a || typeof a !== 'object') return null;
  const line = [a.street, a.city, a.state, a.postalCode ?? a.zipCode, a.country]
    .map((p) => (typeof p === 'string' ? p.trim() : ''))
    .filter(Boolean)
    .join(', ');
  return line || null;
};

const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
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
export function monthWindow(endIso: string, count: number): MonthSlot[] {
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
export function monthSpan(startIso: string, endIso: string): number {
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
 * The DOCUMENT behind a general_ledger row (alias `g`), for every drill-down.
 *
 * `g.reference` is the JE number (JE-005). That identifies the posting, and a
 * posting is not what anyone is looking for: asked "what is in Sales Revenue",
 * the answer is INV-2026-0001 for Acme Ltd, not JE-005. One LEFT JOIN per
 * source family, keyed on (source_type, source_id) — a join per family, not
 * per row.
 *
 * Deliveries need their own join even though they post through an invoice:
 * the GL row carries the DELIVERY's id, not the invoice's, so without this a
 * delivery-approval COGS row falls back to its journal number and names
 * nobody.
 *
 * One definition, used by the statement-line drill-down, the account register,
 * the cash-flow line drill-down and the account movement analysis, so the
 * same row names the same document everywhere.
 */
const DOCUMENT_COLUMNS = `COALESCE(inv.invoice_number, bl.bill_number, cm.credit_memo_number,
                       vc.vendor_credit_number, po.po_number,
                       pay.payment_number, bp.reference,
                       dinv.invoice_number, dl.reference_no)   AS "documentNumber",
              COALESCE(ic.name, cc.name, pc.name,
                       bv.company_name, vv.company_name,
                       pv.company_name, bpv.company_name,
                       dc.name)                                AS "counterpartyName"`;

const DOCUMENT_JOINS = `LEFT JOIN invoices inv       ON inv.id = g.source_id
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
         LEFT JOIN customers dc       ON dc.id = dl.customer_id`;

/**
 * One ledger row as every drill-down returns it. `signed` applies the
 * account's normal balance, so the entries add up to the figure that was
 * tapped rather than to its negative.
 */
const ledgerEntry = (row: any, signed: (dr: number, cr: number) => number) => ({
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
});

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
/**
 * SQL for the date from which a company's stock-value series is exact.
 *
 * `inventory_cost_history_from` is written once, by the 1789930000000
 * backfill, and only for companies that already had stock movements then.
 * Every movement since has had to carry its value (CHECK value_change IS NOT
 * NULL, 1789920000000), so a company the backfill skipped — one created later,
 * or one with no stock yet — has a series that is exact from its very first
 * movement. Reading the column alone left every such company at NULL, and its
 * owner was told no movement had recorded its cost, for stock whose cost was
 * always recorded. MIN(date) is a lookup on the (company_id, date) index, and
 * COALESCE only evaluates it when the column is NULL.
 *
 * `companyAlias` must name a `companies` row in the surrounding query.
 */
export const costHistoryFromSql = (companyAlias: string): string =>
  `COALESCE(${companyAlias}.inventory_cost_history_from,
            (SELECT MIN(hm.date) FROM inventory_movements hm
              WHERE hm.company_id = ${companyAlias}.id))`;

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
    @InjectRepository(Invoice)
    private readonly invoiceRepo: Repository<Invoice>,
    @InjectRepository(Bill) private readonly billRepo: Repository<Bill>,
    @InjectRepository(InventoryItem)
    private readonly itemRepo: Repository<InventoryItem>,
    @InjectRepository(InventoryMovement)
    private readonly moveRepo: Repository<InventoryMovement>,
    @InjectRepository(Delivery)
    private readonly deliveryRepo: Repository<Delivery>,
    @InjectRepository(TaxPayment)
    private readonly taxRepo: Repository<TaxPayment>,
    private readonly dataSource: DataSource,
    // Signs the item photo links the item explorer shows. Optional, so the
    // test modules that build this service without inventory still compile;
    // without it the explorer simply has no photo.
    @Optional() private readonly mediaSigner?: MediaUrlSigner,
  ) {}

  private async sum(
    table: 'invoices' | 'bills',
    col: string,
    companyId: string,
    dateCol?: string,
    s?: string,
    e?: string,
  ) {
    let sql = `SELECT COALESCE(SUM(${col}::numeric),0) AS total FROM ${table} WHERE company_id=$1 AND status NOT IN ('void','draft')`;
    const params: any[] = [companyId];
    if (dateCol && s && e) {
      sql += ` AND ${dateCol} BETWEEN $2 AND $3`;
      params.push(s, e);
    }
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
      isActive?: boolean;
    }[]
  > {
    return this.dataSource.query(
      `SELECT a.account_number AS "accountNumber", a.name AS "accountName",
              a.type AS "type", a.sub_type AS "subType", a.is_active AS "isActive",
              COALESCE(SUM(g.debit::numeric), 0) AS dr,
              COALESCE(SUM(g.credit::numeric), 0) AS cr
       FROM accounts a
       LEFT JOIN general_ledger g
         ON g.account_id = a.id AND g.company_id = $1
         AND g.date >= $2 AND g.date <= $3
       WHERE a.company_id = $1
       GROUP BY a.id, a.account_number, a.name, a.type, a.sub_type, a.is_active
       ORDER BY a.account_number`,
      [companyId, startDate, endDate],
    );
  }

  /** Cost of goods sold — the shared rule in statement-groups.ts. */
  private isCogs(row: { accountNumber: string; subType: string }): boolean {
    return isCogsAccount(row);
  }

  /**
   * NON-operating income or expense — interest, FX, disposals, one-offs.
   * Kept out of the operating subtotal so `netOperatingIncome` reflects the
   * trade the business actually runs. The rule (7xxx/8xxx, or the subtypes
   * 'Other Revenue', 'Interest' and 'Other Expense') lives in
   * statement-groups.ts so the trial balance and the KPIs split exactly as
   * the P&L does.
   */
  private isOther(row: {
    accountNumber: string;
    subType: string;
    type?: string;
  }): boolean {
    return isNonOperatingAccount(row);
  }

  /**
   * The company's fiscal-year start month. One source of truth (D1):
   * `companies.fiscal_year_start_month`, NULL meaning January. Parsed
   * defensively — anything unusable is January, never an exception.
   */
  async fiscalYearStartMonth(companyId: string): Promise<number> {
    const rows = await this.dataSource.query(
      `SELECT c.fiscal_year_start_month AS month FROM companies c WHERE c.id = $1`,
      [companyId],
    );
    return clampMonth(rows?.[0]?.month);
  }

  /**
   * Revenue − COGS − expense over GL rows, as profitLoss computes it: the
   * displayed figure goes through a ROUNDED gross profit, exactly like
   * profitLoss's `netIncome`, while `raw` stays at full precision for
   * anything that has to tie. See the note in balanceSheetCore for why the
   * two differ.
   */
  /**
   * The GL before a fiscal year, as all-time less the year itself, account by
   * account. Same figures as a second pass over everything before the year,
   * without that pass: on a ledger with a long history it is the slowest query
   * a statement runs, and the balance sheet already has both halves.
   */
  private priorWindowRows<
    T extends {
      accountNumber: string;
      type: string;
      subType: string;
      dr: string;
      cr: string;
    },
  >(allRows: T[], currentRows: T[]): T[] {
    const current = new Map(currentRows.map((r) => [r.accountNumber, r]));
    return allRows.map((r) => {
      const c = current.get(r.accountNumber);
      return {
        ...r,
        dr: String(num(r.dr) - num(c?.dr)),
        cr: String(num(r.cr) - num(c?.cr)),
      };
    });
  }

  private earningsOf(
    rows: Array<{
      type: string;
      dr: string;
      cr: string;
      accountNumber: string;
      subType: string;
    }>,
  ): { raw: number; display: number } {
    let revenue = 0;
    let cogs = 0;
    let expense = 0;
    for (const row of rows) {
      const dr = num(row.dr);
      const cr = num(row.cr);
      if (row.type === 'revenue') revenue += cr - dr;
      else if (row.type === 'expense') {
        if (this.isCogs(row)) cogs += dr - cr;
        else expense += dr - cr;
      }
    }
    return {
      raw: revenue - cogs - expense,
      display: r2(r2(revenue - cogs) - expense),
    };
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
   * profitLoss() — and its rounding path too, through a rounded gross profit,
   * so the cash-flow statement's starting figure is the P&L's bottom line to
   * the paisa rather than one that can sit a paisa off it.
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
    return this.earningsOf(rows).display;
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
    // Operating income is OPERATING revenue less cost and operating expense.
    // It used to start from `grossProfit`, which carries ALL revenue, so any
    // other income was counted twice — once here and again in netOtherIncome
    // — and the two did not add up to netIncome. From raw figures, rounded once.
    const netOperatingIncome = r2(sum(income) - cogs - sum(expenseRows));
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
  /**
   * Everything the balance sheet knows at one date, at FULL precision.
   *
   * The legacy fields (assets/liabilities/equity, the three totals and
   * isBalanced) are computed exactly as they always were — same query first,
   * same raw footing, same verdict — so their values cannot move. What is new
   * is how earnings are PRESENTED inside equity:
   *
   *  - Retained earnings = net income from inception to the day before the
   *    current fiscal year starts. When the chart has a Retained Earnings
   *    account (3100 in the seeded chart) that line carries its own posted
   *    balance plus those earnings, and says so in `composite`. Without one,
   *    a synthetic line shows them.
   *  - Net income for the current fiscal year, start of year → asOf.
   *
   * It used to be one line, "Net Income (current period)", carrying earnings
   * since inception under code 3100 — the code of a real account, so a chart
   * with a posted 3100 showed two lines with the same code. Synthetic lines
   * now carry accountCode '' and a `synthetic` marker; no real code is reused.
   */
  private async balanceSheetCore(
    companyId: string,
    asOf: string,
    includeZero = false,
  ) {
    // FIRST query, unchanged: the all-time GL as of the date.
    const rows = await this.glByAccount(
      companyId,
      REPORT_RANGE_DEFAULTS.startDate,
      asOf,
    );
    const startMonth = await this.fiscalYearStartMonth(companyId);
    const fyStart = fiscalYearStart(startMonth, asOf);
    const currentRows = await this.glByAccount(companyId, fyStart, asOf);
    const priorRows = this.priorWindowRows(rows, currentRows);

    const assets: {
      accountCode: string;
      accountName: string;
      amount: number;
    }[] = [];
    const liabilities: {
      accountCode: string;
      accountName: string;
      amount: number;
    }[] = [];
    const equity: BalanceSheetLine[] = [];
    /** Every line at full precision, for the sections and the comparison. */
    const lines: Array<
      BalanceSheetLine & {
        raw: number;
        group: StatementGroupKey;
        subType: string | null;
      }
    > = [];
    let revenue = 0;
    let cogs = 0;
    let expense = 0;
    // Footed from the UNROUNDED figures — see the note above the totals.
    let rawAssets = 0;
    let rawLiabilities = 0;
    let rawEquity = 0;

    // Earnings split at the fiscal-year boundary, each through profitLoss's
    // own rounding path, so `currentYearEarnings` IS the P&L for the year to
    // date and `priorYearsEarnings` IS the P&L for everything before it.
    const priorYears = this.earningsOf(priorRows);
    const currentYear = this.earningsOf(currentRows);
    // The chart's Retained Earnings account, if it has one: the lowest-numbered
    // account of that subtype (rows arrive ordered by account number).
    const reAccount = rows.find(
      (r) => r.type === 'equity' && r.subType === 'Retained Earnings',
    );

    for (const row of rows) {
      const dr = num(row.dr);
      const cr = num(row.cr);
      const group = classifyForStatement(
        row.type,
        row.subType,
        row.accountNumber,
      );
      const line = (amount: number) => ({
        accountCode: row.accountNumber,
        accountName: row.accountName,
        amount: r2(amount),
      });
      // With `includeZero`, an active account with no balance still gets a
      // line in its section (never in the flat legacy arrays), so a reader
      // can see the whole chart; it adds nothing to any total.
      const zeroLine = () =>
        includeZero && row.isActive !== false
          ? lines.push({
              ...line(0),
              raw: 0,
              group: group ?? 'equity',
              subType: row.subType,
            })
          : 0;
      if (row.type === 'asset') {
        const amt = dr - cr;
        if (Math.abs(amt) > 0.0001) {
          assets.push(line(amt));
          lines.push({
            ...line(amt),
            raw: amt,
            group: group!,
            subType: row.subType,
          });
          rawAssets += amt;
        } else zeroLine();
      } else if (row.type === 'liability') {
        const amt = cr - dr;
        if (Math.abs(amt) > 0.0001) {
          liabilities.push(line(amt));
          lines.push({
            ...line(amt),
            raw: amt,
            group: group!,
            subType: row.subType,
          });
          rawLiabilities += amt;
        } else zeroLine();
      } else if (row.type === 'equity') {
        const amt = cr - dr;
        if (row === reAccount) {
          // Its own balance plus every earlier year's earnings. Displayed as
          // the sum of the two displayed parts, so `composite` foots to it.
          const shown = r2(r2(amt) + priorYears.display);
          if (Math.abs(amt + priorYears.raw) > 0.0001) {
            const reLine: BalanceSheetLine = {
              accountCode: row.accountNumber,
              accountName: row.accountName,
              amount: shown,
              composite: {
                postedBalance: r2(amt),
                priorYearsEarnings: priorYears.display,
              },
            };
            equity.push(reLine);
            lines.push({
              ...reLine,
              raw: amt + priorYears.raw,
              group: 'equity',
              subType: row.subType,
            });
          } else zeroLine();
        } else if (Math.abs(amt) > 0.0001) {
          equity.push(line(amt));
          lines.push({
            ...line(amt),
            raw: amt,
            group: 'equity',
            subType: row.subType,
          });
        } else zeroLine();
        if (Math.abs(amt) > 0.0001) rawEquity += amt;
      } else if (row.type === 'revenue') revenue += cr - dr;
      else if (row.type === 'expense') {
        // Split exactly as profitLoss splits it — see the note below.
        if (this.isCogs(row)) cogs += dr - cr;
        else expense += dr - cr;
      }
    }

    // Earnings (revenue − expense) roll into equity so the sheet balances
    // (FinMatrixGuide §5.3).
    //
    // The DISPLAYED figures are derived the way profitLoss derives its
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
    // rawEquity and therefore what decides whether A = L + E. It is still the
    // all-time figure: the fiscal-year split below changes how earnings are
    // presented, never how much of them there is.
    const rawNetIncome = revenue - cogs - expense;
    const netIncome = r2(r2(revenue - cogs) - expense);
    if (Math.abs(netIncome) > 0.0001) rawEquity += rawNetIncome;

    if (!reAccount && Math.abs(priorYears.display) > 0.0001) {
      const reLine: BalanceSheetLine = {
        accountCode: '',
        accountName: 'Retained Earnings',
        amount: priorYears.display,
        synthetic: 'retainedEarnings',
      };
      equity.push(reLine);
      lines.push({
        ...reLine,
        raw: priorYears.raw,
        group: 'equity',
        subType: null,
      });
    }
    if (Math.abs(currentYear.display) > 0.0001) {
      const cyLine: BalanceSheetLine = {
        accountCode: '',
        accountName: 'Net Income (current fiscal year)',
        amount: currentYear.display,
        synthetic: 'currentYearEarnings',
      };
      equity.push(cyLine);
      lines.push({
        ...cyLine,
        raw: currentYear.raw,
        group: 'equity',
        subType: null,
      });
    }

    return {
      asOf,
      fyStart,
      assets,
      liabilities,
      equity,
      lines,
      rawAssets,
      rawLiabilities,
      rawEquity,
      priorYears,
      currentYear,
      reAccount: reAccount
        ? {
            accountCode: reAccount.accountNumber,
            posted: num(reAccount.cr) - num(reAccount.dr),
          }
        : null,
    };
  }

  async balanceSheet(
    companyId: string,
    asOfDate: string,
    compareTo?: string,
    opts: { includeZero?: boolean } = {},
  ): Promise<BalanceSheetReport> {
    const asOf = asOfDate || reportToday();
    const core = await this.balanceSheetCore(companyId, asOf, opts.includeZero);
    const prior = compareTo
      ? await this.balanceSheetCore(companyId, compareTo, opts.includeZero)
      : null;

    const { rawAssets, rawLiabilities, rawEquity } = core;
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
    const isBalanced =
      Math.abs(rawAssets - (rawLiabilities + rawEquity)) < 0.01;

    const { sections, subtotals } = this.balanceSheetSections(core, prior);
    return {
      asOfDate: asOf,
      assets: core.assets,
      liabilities: core.liabilities,
      equity: core.equity,
      totalAssets,
      totalLiabilities,
      totalEquity,
      isBalanced,
      // ── additive (v2) ──
      fiscalYearStart: core.fyStart,
      totalLiabilitiesAndEquity: r2(rawLiabilities + rawEquity),
      gap: r2(rawAssets - (rawLiabilities + rawEquity)),
      sections,
      subtotals,
      comparison: prior
        ? {
            asOfDate: prior.asOf,
            totalAssets: r2(prior.rawAssets),
            totalLiabilities: r2(prior.rawLiabilities),
            totalEquity: r2(prior.rawEquity),
          }
        : null,
    };
  }

  /**
   * The balance sheet grouped the way it is read — cash, receivables, stock,
   * other current assets, fixed assets, then current and long-term
   * liabilities and equity — by classifyForStatement, so every client shows
   * the same groups instead of guessing them from account numbers.
   *
   * With a comparison date each line also carries its prior amount and the
   * change. An account that is zero now but was not then still appears: a
   * loan that has been repaid is exactly the kind of change a reader needs to
   * see. Lines are matched by account code, synthetic ones by their marker.
   */
  private balanceSheetSections(
    core: Awaited<ReturnType<ReportsService['balanceSheetCore']>>,
    prior: Awaited<ReturnType<ReportsService['balanceSheetCore']>> | null,
  ): { sections: BalanceSheetSection[]; subtotals: BalanceSheetSubtotal[] } {
    const keyOf = (l: { accountCode: string; synthetic?: string }) =>
      l.synthetic ? `synthetic:${l.synthetic}` : l.accountCode;
    const priorByKey = new Map((prior?.lines ?? []).map((l) => [keyOf(l), l]));
    const nowKeys = new Set(core.lines.map(keyOf));
    // Prior-only lines, carried at zero now.
    const merged = [
      ...core.lines.map((l) => ({
        now: l,
        then: priorByKey.get(keyOf(l)) ?? null,
      })),
      ...(prior?.lines ?? [])
        .filter((l) => !nowKeys.has(keyOf(l)))
        .map((l) => ({ now: { ...l, amount: 0, raw: 0 }, then: l })),
    ];

    const pct = (part: number, whole: number) =>
      Math.abs(whole) > EPS ? r2((part / whole) * 100) : null;
    /**
     * A figure with its prior value, change and change % — the same null rules
     * as a line: no comparison → nulls; a prior of zero → changePct null.
     * `change` is the difference of the two DISPLAYED figures.
     */
    const comparable = (rawNow: number, rawThen: number | null) => {
      const now = r2(rawNow);
      const then = rawThen === null ? null : r2(rawThen);
      return {
        now,
        then,
        change: then === null ? null : r2(now - then),
        changePct: rawThen === null ? null : pct(rawNow - rawThen, rawThen),
        ofAssets: pct(rawNow, core.rawAssets),
      };
    };

    const sections: BalanceSheetSection[] = STATEMENT_GROUPS.map((g) => {
      const inGroup = merged
        .filter((m) => m.now.group === g.key)
        .sort((a, b) =>
          // Real accounts by code; synthetic lines after them.
          (a.now.accountCode || '~').localeCompare(b.now.accountCode || '~'),
        );
      const rawSubtotal = inGroup.reduce((t, m) => t + m.now.raw, 0);
      const rawPrior = inGroup.reduce((t, m) => t + (m.then?.raw ?? 0), 0);
      return {
        key: g.key,
        label: g.label,
        lines: inGroup.map(({ now, then }) => {
          const priorAmount = prior ? r2(then?.raw ?? 0) : null;
          // current − prior as printed, so the column visibly subtracts.
          const change = prior ? r2(r2(now.raw) - (priorAmount ?? 0)) : null;
          return {
            accountCode: now.accountCode,
            accountName: now.accountName,
            subType: now.subType,
            amount: r2(now.raw),
            priorAmount,
            change,
            // Null, never Infinity, when there was nothing to compare against.
            changePct: prior
              ? pct(now.raw - (then?.raw ?? 0), then?.raw ?? 0)
              : null,
            pctOfTotalAssets: pct(now.raw, core.rawAssets),
            ...(now.synthetic ? { synthetic: now.synthetic } : {}),
            ...(now.composite ? { composite: now.composite } : {}),
          };
        }),
        // Equity's subtotal is totalEquity itself: the earnings lines are a
        // presentation of the same raw figure, never a second sum of it.
        ...(() => {
          const c = comparable(
            g.key === 'equity' ? core.rawEquity : rawSubtotal,
            prior ? (g.key === 'equity' ? prior.rawEquity : rawPrior) : null,
          );
          return {
            subtotal: c.now,
            priorSubtotal: c.then,
            change: c.change,
            changePct: c.changePct,
            subtotalPctOfTotalAssets: c.ofAssets,
          };
        })(),
      };
    });

    const rawOf = (c: typeof core | null, keys: StatementGroupKey[]) =>
      c
        ? c.lines
            .filter((l) => keys.includes(l.group))
            .reduce((t, l) => t + l.raw, 0)
        : 0;
    const CURRENT_ASSETS: StatementGroupKey[] = [
      'cashAndBank',
      'receivables',
      'inventory',
      'otherCurrentAssets',
    ];
    const subtotal = (
      key: string,
      label: string,
      now: number,
      then: number | null,
    ): BalanceSheetSubtotal => {
      const c = comparable(now, then);
      return {
        key,
        label,
        amount: c.now,
        priorAmount: c.then,
        change: c.change,
        changePct: c.changePct,
        pctOfTotalAssets: c.ofAssets,
      };
    };
    const subtotals: BalanceSheetSubtotal[] = [
      subtotal(
        'totalCurrentAssets',
        'Total Current Assets',
        rawOf(core, CURRENT_ASSETS),
        prior ? rawOf(prior, CURRENT_ASSETS) : null,
      ),
      subtotal(
        'totalAssets',
        'Total Assets',
        core.rawAssets,
        prior ? prior.rawAssets : null,
      ),
      subtotal(
        'totalCurrentLiabilities',
        'Total Current Liabilities',
        rawOf(core, ['currentLiabilities']),
        prior ? rawOf(prior, ['currentLiabilities']) : null,
      ),
      subtotal(
        'totalLiabilities',
        'Total Liabilities',
        core.rawLiabilities,
        prior ? prior.rawLiabilities : null,
      ),
      subtotal(
        'totalEquity',
        'Total Equity',
        core.rawEquity,
        prior ? prior.rawEquity : null,
      ),
      subtotal(
        'totalLiabilitiesAndEquity',
        'Total Liabilities and Equity',
        core.rawLiabilities + core.rawEquity,
        prior ? prior.rawLiabilities + prior.rawEquity : null,
      ),
    ];
    return { sections, subtotals };
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
  private async savedAgingPreference(
    companyId: string,
  ): Promise<AgingSpecRequest | null> {
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
      !!request &&
      (request.preset === 'custom'
        ? !!request.buckets
        : !!request.preset || !!request.buckets);
    try {
      return resolveAgingSpec(
        request ?? null,
        selfContained ? null : await this.savedAgingPreference(companyId),
      );
    } catch (err) {
      if (err instanceof AgingBucketSpecError) {
        throw new BadRequestException({
          code: 'INVALID_AGING_BUCKETS',
          message: err.message,
        });
      }
      throw err;
    }
  }

  /**
   * @param opts.withInsights v2 — add `insights` and the per-party fields (see
   *   withAgingInsights). The JSON route asks for them; the CSV export,
   *   /aging and the analytics dashboard do not, so their output is unchanged.
   */
  async arAging(
    companyId: string,
    request?: AgingSpecRequest,
    opts?: { withInsights?: boolean },
  ) {
    const spec = await this.resolveSpecFor(companyId, request);
    const rowsRaw = await this.dataSource.query(
      `SELECT i.customer_id AS "customerId", c.name AS "customerName", i.balance::numeric AS balance, i.due_date::text AS "dueDate"
       FROM invoices i JOIN customers c ON c.id = i.customer_id
       WHERE i.company_id=$1 AND ${openDocPredicate('i')}`,
      [companyId],
    );
    const report = this.bucketAging(
      rowsRaw,
      spec,
      'customerId',
      'customerName',
    );
    return opts?.withInsights
      ? this.bestEffortAgingInsights(companyId, 'customer', rowsRaw, report)
      : report;
  }

  async apAging(
    companyId: string,
    request?: AgingSpecRequest,
    opts?: { withInsights?: boolean },
  ) {
    const spec = await this.resolveSpecFor(companyId, request);
    const rowsRaw = await this.dataSource.query(
      `SELECT b.vendor_id AS "customerId", v.company_name AS "customerName", b.balance::numeric AS balance, b.due_date::text AS "dueDate"
       FROM bills b JOIN vendors v ON v.id = b.vendor_id
       WHERE b.company_id=$1 AND ${openDocPredicate('b')}`,
      [companyId],
    );
    const report = this.bucketAging(
      rowsRaw,
      spec,
      'customerId',
      'customerName',
    );
    return opts?.withInsights
      ? this.bestEffortAgingInsights(companyId, 'vendor', rowsRaw, report)
      : report;
  }

  /**
   * withAgingInsights, never at the cost of the report itself: aging is a
   * long-standing endpoint, the insights are a v2 extra. If enriching fails
   * the report goes out exactly as before (no `insights`, no party fields)
   * and the failure is logged.
   */
  private async bestEffortAgingInsights(
    companyId: string,
    partyType: 'customer' | 'vendor',
    rowsRaw: any[],
    report: ReturnType<ReportsService['bucketAging']>,
  ) {
    try {
      return await this.withAgingInsights(
        companyId,
        partyType,
        rowsRaw,
        report,
      );
    } catch (err) {
      this.logger.warn(
        `aging insights unavailable for ${companyId}: ${(err as Error)?.message}`,
      );
      return report;
    }
  }

  /**
   * What an aging report means, not just what it holds.
   *
   * `insights`:
   *  - totalOpen — the report's own grand total (`totals.total`);
   *  - overdue / overduePct — balances past their due date;
   *  - weightedAvgDaysOverdue — how late the overdue money is, weighted by
   *    balance, so one large invoice 90 days late is not averaged away by ten
   *    small ones a day late (null when nothing is overdue);
   *  - top5SharePct — how much of the book five parties hold;
   *  - schedule — what falls due when, by due date from today: overdue, then
   *    0–7, 8–14, 15–30, 31–60 and 60+ days ahead. Every open document is in
   *    exactly one slot and the slots are apportioned to foot to totalOpen.
   * DSO / DPO are KPIs, so ReportsKpiService adds them.
   *
   * Each party row gains its payment terms, credit limit and use (customers),
   * last payment and oldest due date — from one query per field family, never
   * one per party.
   */
  private async withAgingInsights(
    companyId: string,
    partyType: 'customer' | 'vendor',
    rowsRaw: any[],
    report: ReturnType<ReportsService['bucketAging']>,
  ) {
    const today = businessToday();
    const SLOTS = [
      { key: 'overdue', label: 'Overdue' },
      { key: 'd0_7', label: 'Due in 0–7 days' },
      { key: 'd8_14', label: 'Due in 8–14 days' },
      { key: 'd15_30', label: 'Due in 15–30 days' },
      { key: 'd31_60', label: 'Due in 31–60 days' },
      { key: 'd60_plus', label: 'Due in more than 60 days' },
    ] as const;
    const slotOf = (daysOverdue: number) => {
      if (daysOverdue > 0) return 'overdue';
      const ahead = -daysOverdue;
      if (ahead <= 7) return 'd0_7';
      if (ahead <= 14) return 'd8_14';
      if (ahead <= 30) return 'd15_30';
      if (ahead <= 60) return 'd31_60';
      return 'd60_plus';
    };

    const raw = new Map<string, { amount: number; count: number }>(
      SLOTS.map((x) => [x.key, { amount: 0, count: 0 }]),
    );
    let overdueRaw = 0;
    let lateWeighted = 0;
    const oldestDue = new Map<string, string>();
    for (const r of rowsRaw ?? []) {
      const bal = num(r.balance);
      const due = toIsoDay(r.dueDate);
      const days = due === null ? 0 : daysBetweenIso(due, today);
      const slot = raw.get(slotOf(days))!;
      slot.amount += bal;
      slot.count += 1;
      if (days > 0) {
        overdueRaw += bal;
        lateWeighted += bal * days;
      }
      if (
        due &&
        (!oldestDue.has(r.customerId) || due < oldestDue.get(r.customerId)!)
      ) {
        oldestDue.set(r.customerId, due);
      }
    }
    const totalOpen = report.totals.total;
    const amounts = apportionRounding(
      SLOTS.map((x) => raw.get(x.key)!.amount),
      totalOpen,
    );
    const partyTotals = report.rows
      .map((r: any) => r.total)
      .sort((a: number, b: number) => b - a);
    const pctOf = (part: number, whole: number) =>
      Math.abs(whole) > EPS ? r2((part / whole) * 100) : null;

    // ── per-party fields: one query per family ──
    const ids = report.rows.map((r: any) => r.customerId);
    const [parties, lastPayments] = ids.length
      ? await Promise.all([
          partyType === 'customer'
            ? this.dataSource.query(
                `SELECT c.id, c.payment_terms AS "paymentTerms", c.credit_limit::numeric AS "creditLimit"
                   FROM customers c WHERE c.company_id = $1 AND c.id = ANY($2::uuid[])`,
                [companyId, ids],
              )
            : this.dataSource.query(
                `SELECT v.id, v.payment_terms AS "paymentTerms"
                   FROM vendors v WHERE v.company_id = $1 AND v.id = ANY($2::uuid[])`,
                [companyId, ids],
              ),
          partyType === 'customer'
            ? this.dataSource.query(
                `SELECT DISTINCT ON (p.customer_id) p.customer_id AS "partyId",
                        p.payment_date::text AS date, p.amount::numeric AS amount
                   FROM payments p
                  WHERE p.company_id = $1 AND p.customer_id = ANY($2::uuid[])
                  ORDER BY p.customer_id, p.payment_date DESC, p.created_at DESC`,
                [companyId, ids],
              )
            : this.dataSource.query(
                `SELECT DISTINCT ON (bp.vendor_id) bp.vendor_id AS "partyId",
                        bp.payment_date::text AS date, bp.total_amount::numeric AS amount
                   FROM bill_payments bp
                  WHERE bp.company_id = $1 AND bp.vendor_id = ANY($2::uuid[])
                  ORDER BY bp.vendor_id, bp.payment_date DESC, bp.created_at DESC`,
                [companyId, ids],
              ),
        ])
      : [[], []];
    const partyById = new Map<string, any>(
      (parties ?? []).map((p: any) => [p.id, p]),
    );
    const lastById = new Map<string, any>(
      (lastPayments ?? []).map((p: any) => [p.partyId, p]),
    );

    const rows = report.rows.map((r: any) => {
      const party = partyById.get(r.customerId);
      const last = lastById.get(r.customerId);
      const extra: Record<string, unknown> = {
        paymentTerms: party?.paymentTerms ?? null,
      };
      if (partyType === 'customer') {
        // A limit of 0 means "no limit" (credit-control.util), never "zero".
        const limit = num(party?.creditLimit);
        extra.creditLimit = r2(limit);
        extra.overLimit = limit > 0 && r.total > limit;
        extra.creditUsedPct = limit > 0 ? r2((r.total / limit) * 100) : null;
      }
      extra.lastPaymentDate = toIsoDay(last?.date);
      extra.lastPaymentAmount = last ? r2(num(last.amount)) : null;
      extra.oldestDueDate = oldestDue.get(r.customerId) ?? null;
      return { ...r, ...extra };
    });

    return {
      ...report,
      rows,
      insights: {
        totalOpen,
        overdue: r2(overdueRaw),
        overduePct: pctOf(overdueRaw, totalOpen),
        weightedAvgDaysOverdue:
          overdueRaw > EPS ? r2(lateWeighted / overdueRaw) : null,
        top5SharePct: pctOf(
          partyTotals.slice(0, 5).reduce((t: number, x: number) => t + x, 0),
          totalOpen,
        ),
        // Each ratio against its benchmark (kpi-benchmarks.ts). Owing most
        // of your payables to a few suppliers is not a risk in itself, so on
        // the A/P side concentration is stated, not judged.
        assessments: {
          overduePct: assessKpi('overduePct', pctOf(overdueRaw, totalOpen)),
          weightedAvgDaysOverdue: assessKpi(
            'weightedAvgDaysOverdue',
            overdueRaw > EPS ? r2(lateWeighted / overdueRaw) : null,
          ),
          top5SharePct:
            partyType === 'customer'
              ? assessKpi(
                  'top5SharePct',
                  pctOf(
                    partyTotals
                      .slice(0, 5)
                      .reduce((t: number, x: number) => t + x, 0),
                    totalOpen,
                  ),
                )
              : {
                  level: 'neutral' as const,
                  guide: 'How much of what you owe five suppliers hold.',
                },
        },
        schedule: SLOTS.map((x, i) => ({
          key: x.key,
          label: x.label,
          amount: amounts[i],
          count: raw.get(x.key)!.count,
        })),
      },
    };
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
      docQuery: OPEN_INVOICES_SQL,
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
      docQuery: OPEN_BILLS_SQL,
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
      companyId,
      partyId,
      partyType,
      partyQuery,
      docQuery,
      documentType,
      request,
      bucket,
      page,
      limit,
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

    const party = await this.findAgingParty(
      partyQuery,
      partyId,
      companyId,
      partyType,
    );
    const { asOfDate, documents: all } = await this.loadOpenDocuments(
      companyId,
      partyId,
      docQuery,
      documentType,
      spec,
    );

    const matching = bucket ? all.filter((d) => d.bucketKey === bucket) : all;
    // Over every matching document, not just this page — this is the figure
    // that has to foot to the aging row.
    const outstandingTotal = sumBalances(matching);

    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const safePage = Math.max(Math.trunc(page) || 1, 1);
    const start = (safePage - 1) * safeLimit;

    return {
      partyType,
      partyId,
      partyName: party.name,
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
   * The party an aging request names, or a 404.
   *
   * An empty document list would read as "this party owes nothing", a
   * materially more reassuring claim than "there is no such party".
   */
  private async findAgingParty(
    partyQuery: string,
    partyId: string,
    companyId: string,
    partyType: 'customer' | 'vendor',
  ): Promise<Record<string, any>> {
    const rows = await this.dataSource.query(partyQuery, [partyId, companyId]);
    const party = rows?.[0];
    if (party?.name === undefined) {
      throw new NotFoundException({
        code:
          partyType === 'customer' ? 'CUSTOMER_NOT_FOUND' : 'VENDOR_NOT_FOUND',
        message: `No ${partyType} with id ${partyId} in this company.`,
      });
    }
    return party;
  }

  /**
   * One party's open documents, each aged against today and placed in its
   * bucket. The drill-down and the party summary both list from here, so a
   * document's lateness and bucket cannot differ between the two.
   */
  private async loadOpenDocuments(
    companyId: string,
    partyId: string,
    docQuery: string,
    documentType: 'invoice' | 'bill',
    spec: AgingBucketDef[],
  ): Promise<{ asOfDate: string; documents: OpenAgingDocument[] }> {
    const raw: any[] = await this.dataSource.query(docQuery, [
      companyId,
      partyId,
    ]);
    const asOfDate = businessToday();
    const labelFor = new Map(spec.map((b) => [b.key, b.label]));

    const documents = raw.map((r): OpenAgingDocument => {
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
    return { asOfDate, documents };
  }

  /**
   * Everything one customer still owes, as of today — the "outstanding
   * invoices" summary a business sends its customer.
   *
   * Its documents are the aging drill-down's, so `totals.outstanding` is this
   * customer's A/R aging row and the two can be opened side by side. What
   * aging leaves out, this adds: receipts and credit memos not yet used against
   * any invoice. That is money the customer will rightly point to, so a
   * summary that ignored it would overstate what they owe — `netDue` is the
   * figure to ask for.
   */
  async arPartySummary(companyId: string, customerId: string) {
    return this.partySummary({
      companyId,
      partyId: customerId,
      partyType: 'customer',
      documentType: 'invoice',
      partyQuery: `SELECT c.name, c.code, c.contact_person AS "contactPerson", c.email, c.phone,
                c.billing_address AS address, c.payment_terms AS "paymentTerms",
                c.tax_id AS "taxId"
           FROM customers c WHERE c.id = $1 AND c.company_id = $2 LIMIT 1`,
      docQuery: OPEN_INVOICES_SQL,
      loadCredits: async () => {
        // The receive-payment flow's own query, advances held for a delivery
        // still on the road excluded: those belong to that delivery's invoice,
        // which does not exist yet.
        const receipts: UnappliedReceiptRow[] = await this.dataSource.query(
          UNAPPLIED_RECEIPTS_SQL,
          [companyId, customerId, MONEY_TOLERANCE.toFixed(4)],
        );
        const memos: any[] = await this.dataSource.query(
          `SELECT m.id, m.credit_memo_number AS reference, m.date::text AS date,
                  m.total::numeric AS amount, m.balance::numeric AS available
             FROM credit_memos m
            WHERE m.company_id = $1 AND m.customer_id = $2
              AND m.balance::numeric > 0 AND m.status NOT IN ('draft', 'void')
            ORDER BY m.date ASC, m.credit_memo_number ASC`,
          [companyId, customerId],
        );
        return [
          ...receipts.map(
            (p): PartyCredit => ({
              kind: 'payment',
              id: p.id,
              reference: p.payment_number ?? null,
              date: p.payment_date ?? null,
              amount: r2(num(p.amount)),
              available: r2(num(p.unapplied)),
            }),
          ),
          ...memos.map(
            (m): PartyCredit => ({
              kind: 'credit_memo',
              id: m.id,
              reference: m.reference ?? null,
              date: m.date ?? null,
              amount: r2(num(m.amount)),
              available: r2(num(m.available)),
            }),
          ),
        ];
      },
      lastPaymentQuery: `SELECT p.payment_date::text AS date, p.amount::numeric AS amount,
                COALESCE(p.payment_number, p.reference) AS reference
           FROM payments p
          WHERE p.company_id = $1 AND p.customer_id = $2
          ORDER BY p.payment_date DESC, p.created_at DESC
          LIMIT 1`,
    });
  }

  /**
   * Everything the business still owes one vendor, as of today — the
   * payables summary. The A/P twin of {@link arPartySummary}: its total is the
   * vendor's A/P aging row, and open vendor credits come off it.
   */
  async apPartySummary(companyId: string, vendorId: string) {
    return this.partySummary({
      companyId,
      partyId: vendorId,
      partyType: 'vendor',
      documentType: 'bill',
      partyQuery: `SELECT v.company_name AS name, v.code, v.contact_person AS "contactPerson", v.email, v.phone,
                v.address, v.payment_terms AS "paymentTerms", v.tax_id AS "taxId"
           FROM vendors v WHERE v.id = $1 AND v.company_id = $2 LIMIT 1`,
      docQuery: OPEN_BILLS_SQL,
      loadCredits: async () => {
        // The dashboard's pending-A/P figure nets the same credits.
        const credits: any[] = await this.dataSource.query(
          `SELECT vc.id, vc.vendor_credit_number AS reference, vc.date::text AS date,
                  vc.total::numeric AS amount, vc.balance::numeric AS available
             FROM vendor_credits vc
            WHERE vc.company_id = $1 AND vc.vendor_id = $2
              AND vc.balance::numeric > 0 AND vc.status NOT IN ('void', 'closed')
            ORDER BY vc.date ASC, vc.vendor_credit_number ASC`,
          [companyId, vendorId],
        );
        return credits.map(
          (c): PartyCredit => ({
            kind: 'vendor_credit',
            id: c.id,
            reference: c.reference ?? null,
            date: c.date ?? null,
            amount: r2(num(c.amount)),
            available: r2(num(c.available)),
          }),
        );
      },
      lastPaymentQuery: `SELECT bp.payment_date::text AS date, bp.total_amount::numeric AS amount,
                bp.reference
           FROM bill_payments bp
          WHERE bp.company_id = $1 AND bp.vendor_id = $2
          ORDER BY bp.payment_date DESC, bp.created_at DESC
          LIMIT 1`,
    });
  }

  /**
   * One party's open documents with the figures a summary leads with.
   *
   * Buckets are the company's saved aging preference — the ones its aging
   * report shows — and each carries its amount and count, so a client draws
   * the strip without re-bucketing anything. Every total is summed from the
   * rounded document balances, so a printed column foots to its total.
   */
  private async partySummary(args: {
    companyId: string;
    partyId: string;
    partyType: 'customer' | 'vendor';
    documentType: 'invoice' | 'bill';
    partyQuery: string;
    docQuery: string;
    loadCredits: () => Promise<PartyCredit[]>;
    lastPaymentQuery: string;
  }) {
    const {
      companyId,
      partyId,
      partyType,
      documentType,
      partyQuery,
      docQuery,
    } = args;

    const resolved = await this.resolveSpecFor(companyId);
    const party = await this.findAgingParty(
      partyQuery,
      partyId,
      companyId,
      partyType,
    );
    const { asOfDate, documents } = await this.loadOpenDocuments(
      companyId,
      partyId,
      docQuery,
      documentType,
      resolved.spec,
    );

    const buckets = resolved.spec.map((b) => {
      const inBucket = documents.filter((d) => d.bucketKey === b.key);
      return { ...b, amount: sumBalances(inBucket), count: inBucket.length };
    });
    const overdueDocs = documents.filter((d) => d.daysOverdue > 0);
    const outstanding = sumBalances(documents);
    const overdue = sumBalances(overdueDocs);

    const creditItems = (await args.loadCredits()).sort((a, b) =>
      (a.date ?? '').localeCompare(b.date ?? ''),
    );
    const creditTotal = r2(creditItems.reduce((t, c) => t + c.available, 0));

    const [last] = await this.dataSource.query(args.lastPaymentQuery, [
      companyId,
      partyId,
    ]);

    return {
      partyType,
      party: {
        id: partyId,
        code: party.code ?? null,
        name: party.name,
        contactPerson: party.contactPerson ?? null,
        email: party.email ?? null,
        phone: party.phone ?? null,
        address: addressLine(party.address),
        paymentTerms: party.paymentTerms ?? null,
        taxId: party.taxId ?? null,
      },
      asOfDate,
      preset: resolved.preset,
      buckets,
      // NOT `data` — see agingPartyDocuments.
      documents,
      totals: {
        count: documents.length,
        outstanding,
        overdue,
        overdueCount: overdueDocs.length,
        notYetDue: r2(outstanding - overdue),
      },
      credits: { total: creditTotal, items: creditItems },
      // Can be zero or below: credits larger than the open documents mean the
      // business owes the customer (or the vendor owes the business).
      netDue: r2(outstanding - creditTotal),
      lastPayment: last
        ? {
            date: last.date ?? null,
            amount: r2(num(last.amount)),
            reference: last.reference ?? null,
          }
        : null,
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

    const zeroAmounts = () =>
      Object.fromEntries(spec.map((b) => [b.key, 0])) as Record<string, number>;
    const blankLegacy = () => ({
      current: 0,
      bucket1to30: 0,
      bucket31to60: 0,
      bucket61to90: 0,
      bucket90Plus: 0,
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
        map.set(id, {
          customerId: id,
          customerName: name,
          amounts: zeroAmounts(),
          total: 0,
          ...blankLegacy(),
        });
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
        current: r2(e.current),
        bucket1to30: r2(e.bucket1to30),
        bucket31to60: r2(e.bucket31to60),
        bucket61to90: r2(e.bucket61to90),
        bucket90Plus: r2(e.bucket90Plus),
        total: r2(e.total),
      }))
      .sort((a, b) => b.total - a.total);

    const totals = rows.reduce(
      (t, e) => {
        for (const b of spec) t.amounts[b.key] += e.amounts[b.key];
        t.current += e.current;
        t.bucket1to30 += e.bucket1to30;
        t.bucket31to60 += e.bucket31to60;
        t.bucket61to90 += e.bucket61to90;
        t.bucket90Plus += e.bucket90Plus;
        t.total += e.total;
        return t;
      },
      { amounts: zeroAmounts(), ...blankLegacy(), total: 0 },
    );
    for (const b of spec) totals.amounts[b.key] = r2(totals.amounts[b.key]);
    for (const k of [
      'current',
      'bucket1to30',
      'bucket31to60',
      'bucket61to90',
      'bucket90Plus',
      'total',
    ] as const) {
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
    // recorded it — see DOCUMENT_JOINS.
    const rows = await this.dataSource.query(
      `SELECT g.id, g.date::text AS date, g.reference, g.memo,
              g.debit::numeric AS debit, g.credit::numeric AS credit,
              g.source_type AS "sourceType", g.source_id AS "sourceId",
              ${DOCUMENT_COLUMNS}
         FROM general_ledger g
         ${DOCUMENT_JOINS}
        WHERE ${where}
        -- id breaks ties: one posting writes its lines with one timestamp,
        -- and page 2 must continue page 1 exactly.
        ORDER BY g.date DESC, g.created_at DESC, g.id DESC
        LIMIT $5 OFFSET $6`,
      [...params, safeLimit, (safePage - 1) * safeLimit],
    );

    // Signed the way the statement reads this account's normal balance, so the
    // entries add up to the figure the user tapped rather than to its negative.
    const creditNormal =
      account.accountType === 'revenue' ||
      account.accountType === 'liability' ||
      account.accountType === 'equity';
    const signed = (dr: number, cr: number) =>
      creditNormal ? cr - dr : dr - cr;

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
      entries: rows.map((row: any) => ledgerEntry(row, signed)),
      total: totals?.cnt ?? 0,
      page: safePage,
      limit: safeLimit,
    };
  }

  /**
   * One account by its code, or the same 404 the statement drill-down gives.
   * The clients pass a code straight off a statement line, so a miss means the
   * two have drifted apart — never "this account had no activity".
   */
  private async accountByCode(companyId: string, accountCode: string) {
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
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: `No account numbered ${accountCode} in this company.`,
      });
    }
    return account as {
      id: string;
      accountCode: string;
      accountName: string;
      accountType: string;
      subType: string | null;
    };
  }

  /** Revenue, liability and equity accounts read credit-positive. */
  private static creditNormal(accountType: string): boolean {
    return (
      accountType === 'revenue' ||
      accountType === 'liability' ||
      accountType === 'equity'
    );
  }

  /**
   * An account's register: every posting to it, OLDEST first by default — a
   * register reads like a bank statement, from the opening balance down — with
   * the balance after each row.
   *
   * The running balance is a window SUM computed in SQL over the WHOLE range
   * before LIMIT/OFFSET applies, so it is right on page 7 without the client
   * having seen pages 1–6, and right in either sort order. Ties on a date are
   * broken by created_at then id, the same order the balance accumulates in.
   *
   * Opening balance: a balance-sheet account carries everything before the
   * range. A revenue or expense account restarts each fiscal year (that is
   * what closing the books means), so its opening is the year-to-date
   * movement from the start of the fiscal year that contains `startDate` —
   * the same treatment as the working trial balance. Either way,
   * opening + Σ amount = closing.
   */
  async accountRegister(
    companyId: string,
    accountCode: string,
    startDate: string,
    endDate: string,
    page = 1,
    limit = 50,
    order: 'asc' | 'desc' = 'asc',
  ) {
    const s = startDate || REPORT_RANGE_DEFAULTS.startDate;
    const e = endDate || REPORT_RANGE_DEFAULTS.endDate;
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const safePage = Math.max(Math.trunc(page) || 1, 1);
    const dir = order === 'desc' ? 'DESC' : 'ASC';

    const account = await this.accountByCode(companyId, accountCode);
    const creditNormal = ReportsService.creditNormal(account.accountType);
    const signedSql = creditNormal
      ? `(g.credit::numeric - g.debit::numeric)`
      : `(g.debit::numeric - g.credit::numeric)`;
    const signed = (dr: number, cr: number) =>
      creditNormal ? cr - dr : dr - cr;

    const isPnl =
      account.accountType === 'revenue' || account.accountType === 'expense';
    const openFrom = isPnl
      ? fiscalYearStart(await this.fiscalYearStartMonth(companyId), s)
      : REPORT_RANGE_DEFAULTS.startDate;

    const [opening] = await this.dataSource.query(
      `SELECT COALESCE(SUM(${signedSql}), 0) AS v
         FROM general_ledger g
        WHERE g.company_id = $1 AND g.account_id = $2 AND g.date >= $3 AND g.date < $4`,
      [companyId, account.id, openFrom, s],
    );
    const where = `g.company_id = $1 AND g.account_id = $2 AND g.date >= $3 AND g.date <= $4`;
    const params = [companyId, account.id, s, e];
    const [totals] = await this.dataSource.query(
      `SELECT COUNT(*)::int AS cnt,
              COALESCE(SUM(g.debit::numeric), 0) AS dr,
              COALESCE(SUM(g.credit::numeric), 0) AS cr
         FROM general_ledger g WHERE ${where}`,
      params,
    );
    const rows = await this.dataSource.query(
      `SELECT * FROM (
         SELECT g.id, g.date::text AS date, g.reference, g.memo, g.created_at,
                g.debit::numeric AS debit, g.credit::numeric AS credit,
                g.source_type AS "sourceType", g.source_id AS "sourceId",
                ${DOCUMENT_COLUMNS},
                SUM(${signedSql}) OVER (
                  ORDER BY g.date, g.created_at, g.id
                  ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
                ) AS running
           FROM general_ledger g
           ${DOCUMENT_JOINS}
          WHERE ${where}
       ) x
       ORDER BY x.date ${dir}, x.created_at ${dir}, x.id ${dir}
       LIMIT $5 OFFSET $6`,
      [...params, safeLimit, (safePage - 1) * safeLimit],
    );

    const rawOpening = num(opening?.v);
    const rawPeriod = signed(num(totals?.dr), num(totals?.cr));
    return {
      account: {
        accountCode: account.accountCode,
        accountName: account.accountName,
        accountType: account.accountType,
        subType: account.subType,
      },
      range: { startDate: s, endDate: e },
      /** 'cumulative' for balance-sheet accounts; 'fiscalYearToDate' for P&L. */
      openingBasis: isPnl
        ? ('fiscalYearToDate' as const)
        : ('cumulative' as const),
      openingBalance: r2(rawOpening),
      periodDebit: r2(num(totals?.dr)),
      periodCredit: r2(num(totals?.cr)),
      /** The period's movement, signed like the entries — what a P&L line shows. */
      periodNet: r2(rawPeriod),
      closingBalance: r2(rawOpening + rawPeriod),
      // `entries`, never `data` — see statementLineEntries.
      entries: (rows as any[]).map((row) => ({
        ...ledgerEntry(row, signed),
        runningBalance: r2(rawOpening + num(row.running)),
      })),
      total: totals?.cnt ?? 0,
      page: safePage,
      limit: safeLimit,
      order,
    };
  }

  /**
   * Where Retained Earnings comes from, year by year: the balance-sheet line
   * taken apart. Every fiscal year before the current one with its net income
   * (each through profitLoss's rounding path), plus anything posted directly
   * to the Retained Earnings account.
   *
   * `total` is computed exactly as the balance sheet computes its Retained
   * Earnings line — the same query, the same rounding — so the two are equal
   * by construction. The yearly figures are each rounded on their own and can
   * differ from it in the last paisa; the total is what ties.
   */
  async retainedEarnings(companyId: string, asOfDate: string) {
    const asOf = asOfDate || reportToday();
    const startMonth = await this.fiscalYearStartMonth(companyId);
    const fyStart = fiscalYearStart(startMonth, asOf);
    const priorEnd = dayBefore(fyStart);

    const [allRows, currentRows, byYear] = await Promise.all([
      this.glByAccount(companyId, REPORT_RANGE_DEFAULTS.startDate, asOf),
      this.glByAccount(companyId, fyStart, asOf),
      this.dataSource.query(
        `SELECT EXTRACT(YEAR FROM (g.date - make_interval(months => $3::int - 1)))::int AS fy,
                a.account_number AS "accountNumber", a.type, a.sub_type AS "subType",
                COALESCE(SUM(g.debit::numeric), 0) AS dr,
                COALESCE(SUM(g.credit::numeric), 0) AS cr
           FROM general_ledger g JOIN accounts a ON a.id = g.account_id
          WHERE g.company_id = $1 AND g.date <= $2 AND a.type IN ('revenue', 'expense')
          GROUP BY fy, a.account_number, a.type, a.sub_type`,
        [companyId, priorEnd, startMonth],
      ),
    ]);

    const reAccount = allRows.find(
      (r) => r.type === 'equity' && r.subType === 'Retained Earnings',
    );
    const posted = reAccount ? num(reAccount.cr) - num(reAccount.dr) : 0;
    // Derived exactly as balanceSheetCore derives it, so `total` is that line.
    const priorYears = this.earningsOf(
      this.priorWindowRows(allRows, currentRows),
    );

    const years = new Map<number, any[]>();
    for (const r of byYear ?? []) {
      const fy = Number(r.fy);
      years.set(fy, [...(years.get(fy) ?? []), r]);
    }
    const byFiscalYear = [...years.keys()]
      .sort((a, b) => a - b)
      .map((fy) => ({
        fiscalYear: fy,
        startDate: fiscalYearStartOf(startMonth, fy),
        endDate: fiscalYearEndOf(startMonth, fy),
        netIncome: this.earningsOf(years.get(fy)!).display,
      }));

    return {
      asOfDate: asOf,
      fiscalYearStart: fyStart,
      retainedEarningsAccount: reAccount
        ? {
            accountCode: reAccount.accountNumber,
            accountName: reAccount.accountName,
          }
        : null,
      postedTo3100: r2(posted),
      priorYearsEarnings: priorYears.display,
      byFiscalYear,
      // The balance sheet's Retained Earnings line, exactly.
      total: reAccount
        ? r2(r2(posted) + priorYears.display)
        : priorYears.display,
    };
  }

  /**
   * The cash rows behind one cash-flow line.
   *
   * Classified by the same code as the statement (classifyCashPostings), so
   * the rows listed are the rows the line was built from. A posting whose cash
   * was split across lines — a loan repayment with interest, a bill payment
   * for a machine and some stationery — appears under each line with the part
   * allocated to it: `allocatedAmount` and `allocationPct`. Σ allocatedAmount
   * over every page = the line's amount; that is the contract.
   *
   * Paginated in JS, not SQL: the classification that decides membership is
   * JS, so LIMIT/OFFSET in SQL would cut pages short and break the total — the
   * same reasoning as agingPartyDocuments. The document joins run only for
   * the page's own rows.
   */
  async cashFlowLineEntries(
    companyId: string,
    lineKey: string,
    startDate: string,
    endDate: string,
    page = 1,
    limit = 50,
  ) {
    if (!isCashFlowLineKey(lineKey)) {
      throw new BadRequestException({
        code: 'UNKNOWN_LINE_KEY',
        message: `No cash-flow line ${lineKey}. Lines: ${Object.keys(CASH_FLOW_LINES).join(', ')}.`,
      });
    }
    const s = startDate || REPORT_RANGE_DEFAULTS.startDate;
    const e = endDate || reportToday();
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 50, 1), 200);
    const safePage = Math.max(Math.trunc(page) || 1, 1);

    const { flows } = await this.classifyCashPostings(companyId, s, e);
    const items: Array<{ row: LedgerRow; allocated: number; pct: number }> = [];
    // Newest first, like the statement-line drill-down.
    for (const f of [...flows].reverse()) {
      const alloc = f.allocations.find((a) => a.lineKey === lineKey);
      if (!alloc) continue;
      for (const row of [...f.cashRows].reverse()) {
        // A receipt row shares in what came in, a payment row in what went
        // out; a row that gave this line nothing is not listed.
        const pct = cashRowShare(row, alloc);
        if (pct <= 0) continue;
        items.push({ row, allocated: row.amount * pct, pct });
      }
    }
    const rawLine = items.reduce((t, i) => t + i.allocated, 0);
    const pageItems = items.slice(
      (safePage - 1) * safeLimit,
      safePage * safeLimit,
    );

    const docs = pageItems.length
      ? await this.dataSource.query(
          `SELECT g.id, g.date::text AS date, g.reference, g.memo,
                  g.debit::numeric AS debit, g.credit::numeric AS credit,
                  g.source_type AS "sourceType", g.source_id AS "sourceId",
                  ${DOCUMENT_COLUMNS}
             FROM general_ledger g
             ${DOCUMENT_JOINS}
            WHERE g.company_id = $1 AND g.id = ANY($2::uuid[])`,
          [companyId, pageItems.map((i) => i.row.id)],
        )
      : [];
    const docById = new Map<string, any>(
      (docs ?? []).map((d: any) => [d.id, d]),
    );
    const cashSigned = (dr: number, cr: number) => dr - cr;

    const def = CASH_FLOW_LINES[lineKey];
    return {
      lineKey,
      label: def.label,
      section: def.section,
      range: { startDate: s, endDate: e },
      lineAmount: r2(rawLine),
      entries: pageItems.map(({ row, allocated, pct }) => {
        const d = docById.get(row.id) ?? {
          id: row.id,
          debit: Math.max(row.amount, 0),
          credit: Math.max(-row.amount, 0),
        };
        return {
          ...ledgerEntry(d, cashSigned),
          cashAccountCode: row.accountCode,
          cashAccountName: row.accountName ?? null,
          allocatedAmount: r2(allocated),
          allocationPct: r2(pct * 100),
        };
      }),
      total: items.length,
      page: safePage,
      limit: safeLimit,
    };
  }

  /**
   * Why an account moved between two periods: the change broken down by
   * counterparty and by kind of document.
   *
   * With no comparison range given, the comparison is the period of equal
   * length immediately before (precedingPeriod: whole months for a
   * whole-month range) — computed here, so every client compares the same
   * thing. Rows with no customer or vendor behind them (manual journals,
   * adjustments) are the `Unattributed` counterparty; parties beyond `limit`
   * fold into `Other`. Both breakdowns are complete: their changes add up to
   * the account's change, which is rounded once and then apportioned so the
   * printed column foots.
   */
  async accountMovement(
    companyId: string,
    accountCode: string,
    startDate: string,
    endDate: string,
    compareStartDate?: string,
    compareEndDate?: string,
    limit = 10,
  ) {
    const s = startDate;
    const e = endDate;
    let cs = compareStartDate;
    let ce = compareEndDate;
    if (!cs || !ce) ({ startDate: cs, endDate: ce } = precedingPeriod(s, e));
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 10, 1), 50);

    const account = await this.accountByCode(companyId, accountCode);
    const creditNormal = ReportsService.creditNormal(account.accountType);
    const signedSql = creditNormal
      ? `(g.credit::numeric - g.debit::numeric)`
      : `(g.debit::numeric - g.credit::numeric)`;

    const rows = await this.dataSource.query(
      `SELECT x."counterpartyName" AS counterparty, x."sourceType",
              COALESCE(SUM(x.amt) FILTER (WHERE x.date >= $3 AND x.date <= $4), 0) AS cur,
              COALESCE(SUM(x.amt) FILTER (WHERE x.date >= $5 AND x.date <= $6), 0) AS pri
         FROM (
           SELECT g.date, g.source_type AS "sourceType", ${signedSql} AS amt,
                  ${DOCUMENT_COLUMNS}
             FROM general_ledger g
             ${DOCUMENT_JOINS}
            WHERE g.company_id = $1 AND g.account_id = $2
              AND ((g.date >= $3 AND g.date <= $4) OR (g.date >= $5 AND g.date <= $6))
         ) x
        GROUP BY x."counterpartyName", x."sourceType"`,
      [companyId, account.id, s, e, cs, ce],
    );

    const rawCurrent = (rows ?? []).reduce(
      (t: number, r: any) => t + num(r.cur),
      0,
    );
    const rawPrior = (rows ?? []).reduce(
      (t: number, r: any) => t + num(r.pri),
      0,
    );
    const current = r2(rawCurrent);
    const prior = r2(rawPrior);
    // The difference of the two DISPLAYED figures, so the row visibly
    // subtracts. Rounding the raw difference instead can land a paisa away
    // from current − prior as printed, which reads as an arithmetic error.
    const change = r2(current - prior);

    /** Aggregate, sort by |change|, optionally fold the tail, then foot. */
    const breakdown = (keyOf: (r: any) => string, fold: number | null) => {
      const m = new Map<string, { cur: number; pri: number }>();
      for (const r of rows ?? []) {
        const k = keyOf(r);
        const v = m.get(k) ?? { cur: 0, pri: 0 };
        v.cur += num(r.cur);
        v.pri += num(r.pri);
        m.set(k, v);
      }
      let list = [...m.entries()].map(([name, v]) => ({ name, ...v }));
      list.sort((a, b) => Math.abs(b.cur - b.pri) - Math.abs(a.cur - a.pri));
      if (fold !== null && list.length > fold) {
        const tail = list.slice(fold);
        list = [
          ...list.slice(0, fold),
          {
            name: 'Other',
            cur: tail.reduce((t, x) => t + x.cur, 0),
            pri: tail.reduce((t, x) => t + x.pri, 0),
          },
        ];
      }
      const curR = apportionRounding(
        list.map((x) => x.cur),
        current,
      );
      const priR = apportionRounding(
        list.map((x) => x.pri),
        prior,
      );
      const chgR = apportionRounding(
        list.map((x) => x.cur - x.pri),
        change,
      );
      return list.map((x, i) => ({
        name: x.name,
        current: curR[i],
        prior: priR[i],
        change: chgR[i],
      }));
    };

    return {
      account: {
        accountCode: account.accountCode,
        accountName: account.accountName,
        accountType: account.accountType,
        subType: account.subType,
      },
      range: { startDate: s, endDate: e },
      compareRange: { startDate: cs, endDate: ce },
      current,
      prior,
      change,
      changePct:
        Math.abs(rawPrior) > EPS
          ? r2(((rawCurrent - rawPrior) / Math.abs(rawPrior)) * 100)
          : null,
      byCounterparty: breakdown(
        (r) => r.counterparty || 'Unattributed',
        safeLimit,
      ),
      bySourceType: breakdown(
        (r) => SOURCE_TYPE_LABELS[r.sourceType] ?? 'Journal entry',
        null,
      ).map(({ name, ...rest }) => ({ sourceLabel: name, ...rest })),
    };
  }

  // ── Inventory Valuation ──────────────────────────────────────────
  /**
   * @param asOfDate absent — today's snapshot, exactly as it has always been
   *   returned. Given — see inventoryValuationAsOf.
   */
  async inventoryValuation(companyId: string, asOfDate?: string) {
    if (asOfDate) return this.inventoryValuationAsOf(companyId, asOfDate);
    const items = await this.itemRepo.find({ where: { companyId } });
    const rows = items
      .map((it) => {
        const qty = num(it.quantityOnHand);
        const cost = num(it.unitCost);
        return {
          itemId: it.id,
          itemName: it.name,
          sku: it.sku,
          category: it.category ?? 'Uncategorized',
          qty,
          cost,
          value: r2(qty * cost),
        };
      })
      .sort((a, b) => b.value - a.value);
    const catMap = new Map<string, number>();
    for (const row of rows)
      catMap.set(row.category, (catMap.get(row.category) ?? 0) + row.value);
    const byCategory = Array.from(catMap.entries()).map(
      ([category, totalValue]) => ({ category, totalValue: r2(totalValue) }),
    );
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
    return {
      months: count,
      points: await this.inventoryClosings(companyId, businessToday(), count),
    };
  }

  /**
   * GL 1200 at each month end, for `count` months ending with the month of
   * `anchor`. With `cutAtAnchor`, postings dated after `anchor` are left out,
   * so the last point is the balance AS OF that date (what an as-of KPI
   * needs); without it — the public trend's long-standing behaviour — the
   * anchor month closes on everything in it.
   */
  async inventoryClosings(
    companyId: string,
    anchor: string,
    count: number,
    cutAtAnchor = false,
  ) {
    const window = monthWindow(anchor, count);

    const rows = await this.dataSource.query(
      `SELECT to_char(g.date, 'YYYY-MM') AS period,
              COALESCE(SUM(g.debit::numeric - g.credit::numeric), 0) AS net
         FROM general_ledger g
         JOIN accounts a ON a.id = g.account_id AND a.company_id = g.company_id
        WHERE g.company_id = $1 AND a.account_number = '1200'
          ${cutAtAnchor ? 'AND g.date <= $2' : ''}
        GROUP BY period
        ORDER BY period`,
      cutAtAnchor ? [companyId, anchor] : [companyId],
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

    return window.map((slot) => {
      running += netByPeriod.get(slot.period) ?? 0;
      return {
        period: slot.period,
        label: slot.label,
        asOfDate: slot.endDate,
        value: r2(running),
      };
    });
  }

  /**
   * Inventory valuation as of a past date, from the dated movement record:
   * per item, quantity = Σ quantity_change and value = Σ value_change up to
   * the date. Nothing is estimated. A movement that carries no value (rows
   * from before cost was recorded on every movement) makes that item's value
   * null, and `coverage` says how much of the record is valued.
   *
   * `ledgerTie` sets the total beside GL 1200 at the same date. 1250 Goods in
   * Transit is NOT included: stock on a delivery van is not on any shelf the
   * item records describe, and has its own must-clear invariant (I15).
   */
  private async inventoryValuationAsOf(companyId: string, asOf: string) {
    const items = await this.dataSource.query(
      `SELECT it.id AS "itemId", it.name AS "itemName", it.sku,
              COALESCE(it.category, 'Uncategorized') AS category,
              COALESCE(SUM(m.quantity_change::numeric), 0) AS qty,
              COALESCE(SUM(m.value_change::numeric), 0) AS value,
              COUNT(m.id)::int AS moves,
              (COUNT(m.id) FILTER (WHERE m.value_change IS NULL))::int AS unvalued
         FROM inventory_items it
         LEFT JOIN inventory_movements m
                ON m.item_id = it.id AND m.company_id = it.company_id AND m.date <= $2
        WHERE it.company_id = $1
        GROUP BY it.id, it.name, it.sku, it.category`,
      [companyId, asOf],
    );
    const [gl] = await this.dataSource.query(
      `SELECT COALESCE(SUM(g.debit::numeric - g.credit::numeric), 0) AS v
         FROM general_ledger g
         JOIN accounts a ON a.id = g.account_id AND a.company_id = g.company_id
        WHERE g.company_id = $1 AND a.account_number = '1200' AND g.date <= $2`,
      [companyId, asOf],
    );

    let rawTotal = 0;
    let moves = 0;
    let unvalued = 0;
    const rows = (items ?? [])
      .map((r: any) => {
        const qty = num(r.qty);
        const known = Number(r.unvalued) === 0;
        const value = num(r.value);
        if (known) rawTotal += value;
        moves += Number(r.moves);
        unvalued += Number(r.unvalued);
        return {
          itemId: r.itemId,
          itemName: r.itemName,
          sku: r.sku,
          category: r.category,
          qty: r2(qty),
          // The average cost the record implies, where it implies one.
          cost: known && Math.abs(qty) > EPS ? r2(value / qty) : null,
          value: known ? r2(value) : null,
          valueKnown: known,
        };
        // Largest value first; items whose value is unknown go last. Compared
        // explicitly — subtracting two -Infinity placeholders gives NaN, which
        // leaves the order of the unknown items up to the engine.
      })
      .sort((a: any, b: any) =>
        a.value === null && b.value === null
          ? 0
          : a.value === null
            ? 1
            : b.value === null
              ? -1
              : b.value - a.value,
      );

    const catMap = new Map<string, number>();
    for (const row of rows) {
      if (row.value !== null)
        catMap.set(row.category, (catMap.get(row.category) ?? 0) + row.value);
    }
    const totalValue = r2(rawTotal);
    const gl1200 = r2(num(gl?.v));
    return {
      asOfDate: asOf,
      rows,
      byCategory: [...catMap.entries()].map(([category, v]) => ({
        category,
        totalValue: r2(v),
      })),
      totalValue,
      coverage: {
        movements: moves,
        valued: moves - unvalued,
        pct: moves ? r2(((moves - unvalued) / moves) * 100) : 100,
        unvaluedItems: rows.filter((r: any) => !r.valueKnown).length,
      },
      ledgerTie: {
        gl1200,
        valuation: totalValue,
        gap: r2(num(gl?.v) - rawTotal),
        includesGoodsInTransit: false,
      },
    };
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
              (SELECT (${costHistoryFromSql('c')})::text
                 FROM companies c WHERE c.id = $1) AS since
         FROM inventory_movements m
        WHERE m.company_id = $1 AND m.item_id = $2
        GROUP BY period
        ORDER BY period`,
      [companyId, itemId],
    );

    const byPeriod = new Map<string, any>(
      rows.map((r: any) => [r.period as string, r]),
    );
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
   * rest of this response exactly as it did. So are, later:
   *
   *   - `item.imageUrl` / `thumbnailUrl` — the item's photo, signed like the
   *     inventory list's; null without one.
   *   - `item.stockStatus`, `suggestedOrderQty`, `deadStock` — the Health
   *     tab's rules applied to this one item (item-stock.ts), so the two
   *     pages never disagree about it.
   *   - `item.daysOfCover` and `item.cover`, its verdict (kpi-benchmarks.ts).
   *   - `customers[].sharePct` and `otherCustomers.sharePct`.
   *   - `channels` and `returns`: the same lines by document type, which add
   *     up to `totals`.
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

    const byPeriod = new Map<string, any>(
      rows.map((r: any) => [r.period as string, r]),
    );

    // The window is the requested range, expressed as whole months, so a chart
    // keeps a fixed width rather than re-scaling as history accumulates.
    const months = Math.min(Math.max(monthSpan(s, e), 1), 60);
    const window = monthWindow(
      e === REPORT_RANGE_DEFAULTS.endDate ? businessToday() : e,
      months,
    );
    // The customers and channels below read the same months the points do. A
    // custom range longer than sixty months reaches back past the first
    // point, and counting those sales there would leave the parts adding up
    // to more than the totals.
    const firstDay = `${window[0].period}-01`;
    const lastDay = window[window.length - 1].endDate;
    const from = s > firstDay ? s : firstDay;
    const to = e < lastDay ? e : lastDay;

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
      window.reduce(
        (t, slot) => t + num(byPeriod.get(slot.period)?.est_cogs),
        0,
      ),
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
      [companyId, from, to, itemId],
    );
    // A share only means something of a positive whole, for a positive part
    // (the analytics rule): a customer who returned more than they bought is
    // no slice of what was sold.
    const shareOf = (part: number) =>
      revenue > 0 && part >= 0 ? r2((part / revenue) * 100) : null;
    const customers = customerRows.map((r: any) => {
      const rev = r2(num(r.revenue));
      return {
        customerId: r.customerId ?? null,
        customerName: r.customerName || '(no customer)',
        unitsSold: r2(num(r.units)),
        revenue: rev,
        grossProfit: r2(rev - num(r.cogs)),
        sharePct: shareOf(rev),
      };
    });
    const top = customers.slice(0, TOP_CUSTOMERS);
    const rest = customers.slice(TOP_CUSTOMERS);
    const restRevenue = r2(
      rest.reduce((t: number, c: any) => t + c.revenue, 0),
    );

    // How it sold: invoiced over the counter, or sent out on a delivery — and
    // what came back on credit notes. The same lines as the months, grouped
    // by document type, so the channels and returns add up to the totals.
    const channelRows = await this.dataSource.query(
      `SELECT l.doc_type AS "docType",
              COUNT(DISTINCT l.doc_id)::int AS documents,
              SUM(l.units)::numeric(18,4)   AS units,
              SUM(l.revenue)::numeric(18,4) AS revenue,
              SUM(l.cogs)::numeric(18,4)    AS cogs
         FROM (${this.itemSalesLinesSql(false)}) l
        GROUP BY l.doc_type`,
      [companyId, from, to, itemId],
    );
    const byType = new Map<string, any>(
      channelRows.map((r: any) => [r.docType as string, r]),
    );
    const figures = (r: any) => {
      const rev = r2(num(r?.revenue));
      return {
        unitsSold: r2(num(r?.units)),
        revenue: rev,
        grossProfit: r2(rev - num(r?.cogs)),
        documents: Number(r?.documents ?? 0),
      };
    };
    const sold = (['invoice', 'delivery'] as const)
      .filter((k) => byType.has(k))
      .map((key) => ({ key, ...figures(byType.get(key)) }));
    // Shares of what went out, before anything came back.
    const gross = r2(sold.reduce((t, c) => t + c.revenue, 0));
    const channels = sold.map((c) => ({
      ...c,
      sharePct:
        gross > 0 && c.revenue >= 0 ? r2((c.revenue / gross) * 100) : null,
    }));
    const returns = byType.has('credit_memo')
      ? figures(byType.get('credit_memo'))
      : null;

    // The horizon, and the last time the item sold at all — not just in this
    // range, because "not sold since March" is the answer to a range that is
    // empty. Returns are not sales here: taking stock back is not selling it.
    const [meta] = await this.dataSource.query(
      `SELECT (SELECT (${costHistoryFromSql('c')})::text
                 FROM companies c WHERE c.id = $1) AS since,
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

    // Where the item is kept, and the last time stock went out of it — by the
    // Health tab's outbound rule, so "dead stock" means the same on both.
    const today = businessToday();
    const [stockMeta] = await this.dataSource.query(
      `SELECT loc.name AS location,
              (SELECT MAX(m.date)::text
                 FROM inventory_movements m
                WHERE m.company_id = $1 AND m.item_id = $2
                  AND m.date <= $3 AND ${OUTBOUND_SQL}) AS last_out
         FROM inventory_items it
         LEFT JOIN inventory_locations loc
           ON loc.id = it.location_id AND loc.company_id = $1
        WHERE it.id = $2 AND it.company_id = $1`,
      [companyId, itemId, today],
    );

    const qtyOnHand = num(item.quantityOnHand);
    const unitCost = num(item.unitCost);
    const reorderPoint = num(item.reorderPoint);
    const unitsSold = r2(points.reduce((t, p) => t + p.unitsSold, 0));
    const cover = daysOfCover(qtyOnHand, unitsSold, from, to, today);
    const lastOutboundDate = toIsoDay(stockMeta?.last_out);
    const photo = this.mediaSigner?.urlsFor(item.imageId) ?? {
      imageUrl: null,
      thumbnailUrl: null,
    };

    return {
      itemId: item.id,
      itemName: item.name,
      sku: item.sku,
      range: { startDate: s, endDate: e },
      points,
      totals: {
        unitsSold,
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
        reorderPoint: r2(reorderPoint),
        isActive: item.isActive !== false,
        lastSoldDate: toIsoDay(meta?.last_sold),
        imageUrl: photo.imageUrl,
        thumbnailUrl: photo.thumbnailUrl,
        location: stockMeta?.location ?? null,
        stockStatus: itemStockStatus(qtyOnHand, reorderPoint),
        suggestedOrderQty: suggestedOrderQty(
          qtyOnHand,
          reorderPoint,
          num(item.reorderQuantity),
        ),
        daysOfCover: cover,
        cover: assessKpi('daysOfCover', cover),
        deadStock: isDeadStock(qtyOnHand, lastOutboundDate, today),
        lastOutboundDate,
      },
      customers: top,
      otherCustomers: {
        count: rest.length,
        unitsSold: r2(rest.reduce((t: number, c: any) => t + c.unitsSold, 0)),
        revenue: restRevenue,
        grossProfit: r2(
          rest.reduce((t: number, c: any) => t + c.grossProfit, 0),
        ),
        sharePct: rest.length > 0 ? shareOf(restRevenue) : null,
      },
      channels,
      returns,
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
    sort:
      | 'grossProfit'
      | 'revenue'
      | 'marginPct'
      | 'stockValue' = 'grossProfit',
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

    const sum = (f: (x: any) => number) =>
      r2(mapped.reduce((t: number, x: any) => t + f(x), 0));
    const revenue = sum((x) => x.revenue);
    const cogs = sum((x) => x.cogs);
    const estCogs = r2(
      rows.reduce((t: number, r: any) => t + num(r.est_cogs), 0),
    );

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
    const supplierReturns = netOf('5000', [
      'vendor_credit',
      'vendor_credit_void',
    ]);

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
      `SELECT (${costHistoryFromSql('c')})::text AS since
         FROM companies c WHERE c.id = $1`,
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
       FROM deliveries d LEFT JOIN users u ON u.id = d.personnel_id WHERE d.company_id=$1`,
      [companyId],
    );
    const total = deliveries.length;
    const completed = deliveries.filter(
      (d: any) => d.status === 'delivered',
    ).length;
    const failed = deliveries.filter((d: any) => d.status === 'failed').length;
    const onTimePercent = total > 0 ? r2((completed / total) * 100) : 0;

    const pMap = new Map<string, any>();
    for (const d of deliveries) {
      if (!d.personnelId) continue;
      if (!pMap.has(d.personnelId))
        pMap.set(d.personnelId, {
          personId: d.personnelId,
          name: d.personnelName ?? 'Unassigned',
          total: 0,
          delivered: 0,
          failed: 0,
          onTimeRate: 0,
        });
      const e = pMap.get(d.personnelId);
      e.total++;
      if (d.status === 'delivered') e.delivered++;
      if (d.status === 'failed') e.failed++;
    }
    const personnelStats = Array.from(pMap.values()).map((e) => ({
      ...e,
      onTimeRate: e.total > 0 ? r2((e.delivered / e.total) * 100) : 0,
    }));

    const zMap = new Map<string, number>();
    for (const d of deliveries) {
      const z = d.zone ?? 'Unassigned';
      zMap.set(z, (zMap.get(z) ?? 0) + 1);
    }
    const agencyDistribution = Array.from(zMap.entries()).map(([z, count]) => ({
      agencyId: z,
      agencyName: z,
      count,
    }));

    return {
      date: new Date().toISOString().slice(0, 10),
      total,
      completed,
      failed,
      onTimePercent,
      personnelStats,
      agencyDistribution,
    };
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
       GROUP BY label`,
      [companyId],
    );
    const dailyTrend = trendRaw.map((t: any) => ({
      label: (t.label ?? '').trim() || '—',
      delivered: parseInt(t.delivered, 10) || 0,
      failed: parseInt(t.failed, 10) || 0,
    }));
    return { rows, dailyTrend };
  }

  // ── Analytics Dashboard ──────────────────────────────────────────
  async analyticsDashboard(companyId: string) {
    const revRows = await this.dataSource.query(
      `SELECT EXTRACT(YEAR FROM invoice_date::date)::int AS yr, EXTRACT(MONTH FROM invoice_date::date)::int AS mo, SUM(total::numeric) AS v
       FROM invoices WHERE company_id=$1 AND status NOT IN ('void','draft') GROUP BY yr, mo ORDER BY yr, mo`,
      [companyId],
    );
    const billRows = await this.dataSource.query(
      `SELECT EXTRACT(YEAR FROM bill_date::date)::int AS yr, EXTRACT(MONTH FROM bill_date::date)::int AS mo, SUM(total::numeric) AS v
       FROM bills WHERE company_id=$1 AND status NOT IN ('void','draft') GROUP BY yr, mo ORDER BY yr, mo`,
      [companyId],
    );
    const revenueTrend = revRows.slice(-12).map((r: any) => ({
      label: `${MONTH_LABELS[r.mo - 1]} ${String(r.yr).slice(2)}`,
      value: r2(num(r.v)),
    }));
    const billByKey = new Map<string, number>();
    for (const b of billRows) billByKey.set(`${b.yr}-${b.mo}`, num(b.v));
    const cashFlowTrend = revRows.slice(-12).map((r: any) => ({
      label: `${MONTH_LABELS[r.mo - 1]} ${String(r.yr).slice(2)}`,
      value: r2(num(r.v) - (billByKey.get(`${r.yr}-${r.mo}`) ?? 0)),
    }));

    const expRows = await this.dataSource.query(
      `SELECT v.company_name AS label, SUM(b.total::numeric) AS value FROM bills b JOIN vendors v ON v.id=b.vendor_id
       WHERE b.company_id=$1 AND b.status NOT IN ('void','draft') GROUP BY v.company_name ORDER BY value DESC`,
      [companyId],
    );
    const expenseCategories = expRows.map((e: any) => ({
      label: e.label,
      value: r2(num(e.value)),
    }));

    const custRows = await this.dataSource.query(
      `SELECT c.name AS label, SUM(i.total::numeric) AS value FROM invoices i JOIN customers c ON c.id=i.customer_id
       WHERE i.company_id=$1 AND i.status NOT IN ('void','draft') GROUP BY c.name ORDER BY value DESC LIMIT 5`,
      [companyId],
    );
    const topCustomers = custRows.map((c: any) => ({
      label: c.label,
      value: r2(num(c.value)),
    }));

    const aging = await this.arAging(companyId);
    const arAgingTrend = [
      {
        label: 'Current',
        current: aging.totals.current,
        bucket1to30: aging.totals.bucket1to30,
        bucket31to60: aging.totals.bucket31to60,
        bucket61to90: aging.totals.bucket61to90,
        bucket90Plus: aging.totals.bucket90Plus,
      },
    ];

    return {
      revenueTrend,
      expenseCategories,
      cashFlowTrend,
      topCustomers,
      arAgingTrend,
    };
  }

  // ── Simple delivery status breakdown (legacy endpoint) ───────────
  //
  // The range is the business calendar day the delivery was created on. It
  // was accepted and then ignored, so every range answered all-time counts.
  async deliveryReport(companyId: string, startDate: string, endDate: string) {
    const s = startDate || REPORT_RANGE_DEFAULTS.startDate;
    const e = endDate || REPORT_RANGE_DEFAULTS.endDate;
    const qb = this.deliveryRepo
      .createQueryBuilder('d')
      .select('d.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('d.companyId = :cid', { cid: companyId })
      .andWhere(
        'CAST(d.createdAt AT TIME ZONE :tz AS date) BETWEEN :s AND :e',
        {
          tz: businessTimezone(),
          s,
          e,
        },
      )
      .groupBy('d.status');
    return qb.getRawMany();
  }

  async aging(
    companyId: string,
    request?: AgingSpecRequest & { type?: 'ar' | 'ap' },
  ) {
    return request?.type === 'ap'
      ? this.apAging(companyId, request)
      : this.arAging(companyId, request);
  }

  // ── Admin home dashboard summary ─────────────────────────────────
  async dashboardSummary(companyId: string) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
      .toISOString()
      .slice(0, 10);
    const monthEnd = now.toISOString().slice(0, 10);

    const invoiceTotal = await this.sum(
      'invoices',
      'total',
      companyId,
      'invoice_date',
      monthStart,
      monthEnd,
    );
    const billTotal = await this.sum(
      'bills',
      'total',
      companyId,
      'bill_date',
      monthStart,
      monthEnd,
    );
    const outstandingAR = (
      await this.dataSource.query(
        `SELECT COALESCE(SUM(balance::numeric),0) AS v FROM invoices WHERE company_id=$1 AND status NOT IN ('paid','void')`,
        [companyId],
      )
    )[0]?.v;
    // What we owe suppliers, reconciled to account 2000.
    //
    // Two corrections to what this used to be. DRAFT bills post no journal
    // entry at all, so counting them showed money that does not exist in the
    // ledger and never cleared (apAging already excludes them — this was an
    // inconsistency, not a judgement). And an unapplied vendor credit has
    // already been debited to A/P, so the gross bill balances overstate the
    // liability until the credit is applied to a specific bill.
    const pendingAP = (
      await this.dataSource.query(
        `SELECT GREATEST(
                COALESCE((SELECT SUM(balance::numeric) FROM bills
                           WHERE company_id=$1 AND status NOT IN ('paid','void','draft')), 0)
              - COALESCE((SELECT SUM(balance::numeric) FROM vendor_credits
                           WHERE company_id=$1 AND status NOT IN ('void','closed')), 0),
              0) AS v`,
        [companyId],
      )
    )[0]?.v;
    const itemCount = await this.itemRepo.count({ where: { companyId } });
    const deliveryStats = await this.deliveryRepo
      .createQueryBuilder('d')
      .select('d.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('d.companyId = :cid', { cid: companyId })
      .groupBy('d.status')
      .getRawMany();
    const recentInvoices = await this.invoiceRepo
      .createQueryBuilder('i')
      .where('i.companyId = :cid', { cid: companyId })
      .orderBy('i.invoiceDate', 'DESC')
      .limit(5)
      .getMany();
    const recentBills = await this.billRepo
      .createQueryBuilder('b')
      .where('b.companyId = :cid', { cid: companyId })
      .orderBy('b.billDate', 'DESC')
      .limit(5)
      .getMany();

    const deliveryBreakdown: Record<string, number> = {
      pending: 0,
      assigned: 0,
      in_transit: 0,
      delivered: 0,
      failed: 0,
      cancelled: 0,
      unassigned: 0,
    };
    let deliveryTotal = 0;
    for (const row of deliveryStats) {
      deliveryBreakdown[row.status] = parseInt(row.count, 10);
      deliveryTotal += parseInt(row.count, 10);
    }

    const recentTransactions = [
      ...recentInvoices.map((inv) => ({
        id: inv.id,
        type: 'invoice' as const,
        description: inv.invoiceNumber,
        date: inv.invoiceDate,
        amount: num(inv.total),
        status: inv.status,
      })),
      ...recentBills.map((bill) => ({
        id: bill.id,
        type: 'bill' as const,
        description: bill.billNumber,
        date: bill.billDate,
        amount: num(bill.total),
        status: bill.status,
      })),
    ]
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
      .slice(0, 8);

    // Every open invoice past its due date, counted in the database. This used
    // to filter `recentInvoices` — the five latest by invoice date — so it
    // could never report more than five, and an old invoice that had gone
    // overdue was invisible as soon as five newer ones were raised. Same
    // open-document predicate as AR aging, so the count matches the report the
    // alert links to.
    const overdueRow = (
      await this.dataSource.query(
        `SELECT COUNT(*)::int AS n, COALESCE(SUM(i.balance::numeric),0) AS amt
         FROM invoices i
        WHERE i.company_id=$1 AND ${openDocPredicate('i')} AND i.due_date < $2`,
        [companyId, businessToday()],
      )
    )[0];
    const alerts = buildDashboardAlerts({
      overdueCount: Number(overdueRow?.n ?? 0),
      overdueAmount: num(overdueRow?.amt),
      pendingAP: num(pendingAP),
      pendingDeliveries: deliveryBreakdown.pending,
    });

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
      parseInt(
        (await this.dataSource.query(sql, [companyId]))[0]?.v ?? '0',
        10,
      );

    const openingBalance = await count1(
      `SELECT CASE WHEN
         EXISTS (SELECT 1 FROM general_ledger WHERE company_id=$1 AND source_type='opening_balance')
         OR EXISTS (SELECT 1 FROM accounts WHERE company_id=$1 AND opening_balance::numeric <> 0)
       THEN 1 ELSE 0 END AS v`,
    );
    const customAccounts = await count1(
      `SELECT COUNT(*) v FROM accounts WHERE company_id=$1`,
    );
    const customers = await count1(
      `SELECT COUNT(*) v FROM customers WHERE company_id=$1`,
    );
    const vendors = await count1(
      `SELECT COUNT(*) v FROM vendors WHERE company_id=$1`,
    );
    const taxRates = await count1(
      `SELECT COUNT(*) v FROM tax_rates WHERE company_id=$1`,
    );
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
  /**
   * @param mode absent — the PERIOD-MOVEMENT trial balance, exactly as it has
   *   always been returned (no field added; shipped builds read it).
   *   'movement' — the same figures, with each row's group and flags.
   *   'closing' — balances as of endDate: balance-sheet accounts since
   *   inception, revenue and expense for the fiscal year to date, and one
   *   synthetic row carrying earlier years' net income, so it balances.
   *   'working' — opening, period and closing columns side by side.
   */
  async trialBalance(
    companyId: string,
    startDate: string,
    endDate: string,
    mode?: TrialBalanceMode,
    opts: { includeZero?: boolean } = {},
  ) {
    const s = startDate || REPORT_RANGE_DEFAULTS.startDate;
    const e = endDate || REPORT_RANGE_DEFAULTS.endDate;
    if (mode)
      return this.trialBalanceByMode(companyId, s, e, mode, opts.includeZero);

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

  /**
   * The trial balance in an explicit mode (see trialBalance).
   *
   * ── Closing and working: the same split as the balance sheet ─────────────
   * A trial balance "as of" a date cannot simply list every account since
   * inception: revenue and expense restart each fiscal year, and what they
   * earned in earlier years lives in retained earnings. So revenue and expense
   * show the fiscal year to date, and ONE synthetic row — accountCode '',
   * "Retained earnings — prior years' net income" — carries everything they
   * earned before it. That is exactly how balanceSheetCore splits equity, and
   * it is what makes the columns foot: balance-sheet accounts + this year's
   * P&L + earlier years' P&L is the whole ledger, which balances.
   *
   * Every row carries its group and flags, read off its CLOSING balance:
   *  - abnormal_balance: a debit-normal account (assets, expenses, Owner
   *    Draws) with a credit balance, or a credit-normal one with a debit;
   *  - contra_assumed: an asset named like "Accumulated …", presumed to be a
   *    contra account and therefore exempt from abnormal_balance;
   *  - obe_nonzero: Opening Balance Equity not cleared to zero.
   *
   * Column totals are footed from raw figures and the balanced verdict is
   * taken before rounding, per column pair, exactly as the movement trial
   * balance does it.
   */
  private async trialBalanceByMode(
    companyId: string,
    s: string,
    e: string,
    mode: TrialBalanceMode,
    includeZero = false,
  ) {
    type GlRow = Awaited<ReturnType<ReportsService['glByAccount']>>[number];
    const start = REPORT_RANGE_DEFAULTS.startDate;
    const startMonth = await this.fiscalYearStartMonth(companyId);
    const isPnl = (t: string) => t === 'revenue' || t === 'expense';
    const netOf = (r: GlRow | undefined) => (r ? num(r.dr) - num(r.cr) : 0);
    const byCode = (rows: GlRow[]) =>
      new Map(rows.map((r) => [r.accountNumber, r]));

    /** Debit-positive nets as of a date: BS since inception, P&L for its FY. */
    const closingAsOf = async (asOf: string) => {
      const fyStart = fiscalYearStart(startMonth, asOf);
      const [all, fy] = await Promise.all([
        this.glByAccount(companyId, start, asOf),
        this.glByAccount(companyId, fyStart, asOf),
      ]);
      const fyBy = byCode(fy);
      const nets = new Map<string, number>();
      let priorPnl = 0;
      for (const r of all) {
        if (isPnl(r.type)) {
          const inYear = netOf(fyBy.get(r.accountNumber));
          nets.set(r.accountNumber, inYear);
          priorPnl += netOf(r) - inYear;
        } else nets.set(r.accountNumber, netOf(r));
      }
      return { accounts: all, nets, priorPnl, fyStart };
    };

    const RE_ROW = {
      accountNumber: '',
      accountName: "Retained earnings — prior years' net income",
      type: 'equity',
      subType: 'Retained Earnings',
    };
    const flagsFor = (
      acc: { type: string; subType: string | null; accountName: string },
      net: number,
    ) => {
      const flags: Array<
        'abnormal_balance' | 'contra_assumed' | 'obe_nonzero'
      > = [];
      const contra =
        acc.type === 'asset' && /accumulated/i.test(acc.accountName);
      if (contra) flags.push('contra_assumed');
      const debitNormal =
        acc.type === 'asset' ||
        acc.type === 'expense' ||
        (acc.type === 'equity' && acc.subType === 'Owner Draws');
      if (
        !contra &&
        ((debitNormal && net < -0.005) || (!debitNormal && net > 0.005))
      ) {
        flags.push('abnormal_balance');
      }
      if (acc.subType === 'Opening Balance Equity' && Math.abs(net) >= 0.005)
        flags.push('obe_nonzero');
      return flags;
    };
    const dr = (n: number) => (n > 0 ? r2(n) : 0);
    const cr = (n: number) => (n < 0 ? r2(-n) : 0);
    /** Raw-first footing of one column pair; balanced decided before rounding. */
    const foot = (nets: number[]) => {
      const rawDr = nets.reduce((t, n) => (n > 0 ? t + n : t), 0);
      const rawCr = nets.reduce((t, n) => (n < 0 ? t - n : t), 0);
      const balanced = Math.abs(rawDr - rawCr) < 0.01;
      const debit = r2(rawDr);
      return { debit, credit: balanced ? debit : r2(rawCr), balanced };
    };
    const groupKeyOf = (acc: {
      accountNumber: string;
      subType: string | null;
      type: string;
    }) =>
      acc.accountNumber === ''
        ? 'equity'
        : (accountGroupFor(acc) ?? 'otherCurrentAssets');
    const GROUP_ORDER = [
      ...STATEMENT_GROUPS.map((g) => g.key),
      ...PNL_GROUPS.map((g) => g.key),
    ];

    if (mode === 'working') {
      const fyOfS = fiscalYearStart(startMonth, s);
      const before = dayBefore(s);
      const [openAll, openFy, period] = await Promise.all([
        this.glByAccount(companyId, start, before),
        this.glByAccount(companyId, fyOfS, before),
        this.glByAccount(companyId, s, e),
      ]);
      const fyBy = byCode(openFy);
      const periodBy = byCode(period);
      let priorPnl = 0;
      const lines = openAll.map((acc) => {
        let opening = netOf(acc);
        if (isPnl(acc.type)) {
          const inYear = netOf(fyBy.get(acc.accountNumber));
          priorPnl += opening - inYear;
          opening = inYear;
        }
        const moved = netOf(periodBy.get(acc.accountNumber));
        return { acc, opening, moved, closing: opening + moved };
      });
      lines.push({
        acc: RE_ROW as GlRow,
        opening: priorPnl,
        moved: 0,
        closing: priorPnl,
      });
      const shown = lines.filter(
        (l) =>
          Math.abs(l.opening) >= 0.005 ||
          Math.abs(l.moved) >= 0.005 ||
          Math.abs(l.closing) >= 0.005 ||
          // `includeZero`: every active account of the chart, even untouched.
          (includeZero &&
            l.acc.accountNumber !== '' &&
            l.acc.isActive !== false),
      );
      const rows = shown.map((l) => ({
        accountCode: l.acc.accountNumber,
        accountName: l.acc.accountName,
        // `debit`/`credit` mirror the closing columns, so a renderer that only
        // knows the movement shape still shows a sensible balance.
        debit: dr(l.closing),
        credit: cr(l.closing),
        openingDebit: dr(l.opening),
        openingCredit: cr(l.opening),
        periodDebit: dr(l.moved),
        periodCredit: cr(l.moved),
        closingDebit: dr(l.closing),
        closingCredit: cr(l.closing),
        accountType: l.acc.type,
        subType: l.acc.subType,
        group: groupKeyOf(l.acc),
        flags: flagsFor(l.acc, l.closing),
        ...(l.acc.accountNumber === '' ? { synthetic: true } : {}),
      }));
      // Footed over EVERY account, shown or not, as the movement trial
      // balance always has: a row below half a paisa is hidden, but it is
      // still in the books, so whether `includeZero` shows it cannot move a
      // total.
      const o = foot(lines.map((l) => l.opening));
      const p = foot(lines.map((l) => l.moved));
      const c = foot(lines.map((l) => l.closing));
      const groups = GROUP_ORDER.filter((k) =>
        shown.some((l) => groupKeyOf(l.acc) === k),
      ).map((key) => {
        const mine = lines.filter((l) => groupKeyOf(l.acc) === key);
        const pair = (pick: (l: (typeof shown)[number]) => number) => {
          const nets = mine.map(pick);
          return {
            debit: r2(nets.reduce((t, n) => (n > 0 ? t + n : t), 0)),
            credit: r2(nets.reduce((t, n) => (n < 0 ? t - n : t), 0)),
          };
        };
        const op = pair((l) => l.opening);
        const pe = pair((l) => l.moved);
        const cl = pair((l) => l.closing);
        return {
          key,
          label: groupLabel(key),
          debit: cl.debit,
          credit: cl.credit,
          openingDebit: op.debit,
          openingCredit: op.credit,
          periodDebit: pe.debit,
          periodCredit: pe.credit,
          closingDebit: cl.debit,
          closingCredit: cl.credit,
        };
      });
      const warnings: Array<{ code: string; message: string }> = [];
      if (fiscalYearStart(startMonth, e) !== fyOfS) {
        warnings.push({
          code: 'CROSSES_FISCAL_YEAR',
          message:
            `The range runs past the fiscal year that starts ${fyOfS}. Revenue and expense ` +
            'in the closing columns span more than one fiscal year; run one range per year to close each.',
        });
      }
      return {
        range: { startDate: s, endDate: e },
        mode,
        fiscalYearStart: fyOfS,
        rows,
        totalDebits: c.debit,
        totalCredits: c.credit,
        isBalanced: o.balanced && p.balanced && c.balanced,
        balanced: {
          opening: o.balanced,
          period: p.balanced,
          closing: c.balanced,
        },
        totals: {
          openingDebit: o.debit,
          openingCredit: o.credit,
          periodDebit: p.debit,
          periodCredit: p.credit,
          closingDebit: c.debit,
          closingCredit: c.credit,
        },
        groups,
        warnings,
      };
    }

    // movement or closing: one column pair.
    const closing = await closingAsOf(e);
    let lines: Array<{ acc: GlRow; net: number; closingNet: number }>;
    if (mode === 'closing') {
      lines = closing.accounts.map((acc) => {
        const net = closing.nets.get(acc.accountNumber) ?? 0;
        return { acc, net, closingNet: net };
      });
      lines.push({
        acc: RE_ROW as GlRow,
        net: closing.priorPnl,
        closingNet: closing.priorPnl,
      });
    } else {
      const period = await this.glByAccount(companyId, s, e);
      lines = period.map((acc) => ({
        acc,
        net: netOf(acc),
        closingNet: closing.nets.get(acc.accountNumber) ?? 0,
      }));
    }
    const shown = lines.filter(
      (l) =>
        dr(l.net) > 0 ||
        cr(l.net) > 0 ||
        (includeZero && l.acc.accountNumber !== '' && l.acc.isActive !== false),
    );
    const rows = shown.map((l) => ({
      accountCode: l.acc.accountNumber,
      accountName: l.acc.accountName,
      debit: dr(l.net),
      credit: cr(l.net),
      accountType: l.acc.type,
      subType: l.acc.subType,
      group: groupKeyOf(l.acc),
      flags: flagsFor(l.acc, l.closingNet),
      ...(l.acc.accountNumber === '' ? { synthetic: true } : {}),
    }));
    // Every account, shown or not — see the working mode above.
    const t = foot(lines.map((l) => l.net));
    const groups = GROUP_ORDER.filter((k) =>
      shown.some((l) => groupKeyOf(l.acc) === k),
    ).map((key) => {
      const nets = lines
        .filter((l) => groupKeyOf(l.acc) === key)
        .map((l) => l.net);
      return {
        key,
        label: groupLabel(key),
        debit: r2(nets.reduce((a, n) => (n > 0 ? a + n : a), 0)),
        credit: r2(nets.reduce((a, n) => (n < 0 ? a - n : a), 0)),
      };
    });
    return {
      range: { startDate: s, endDate: e },
      mode,
      ...(mode === 'closing'
        ? { asOfDate: e, fiscalYearStart: closing.fyStart }
        : {}),
      rows,
      totalDebits: t.debit,
      totalCredits: t.credit,
      isBalanced: t.balanced,
      groups,
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
  //
  // Each posting's cash is classified by what it was exchanged FOR — the
  // other lines of the same posting — not by the document type that posted
  // it. See cash-flow-classify.ts for the rules and why.
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
    const rawBeginning = num(beginRows[0]?.v);

    const cash = await this.classifyCashPostings(companyId, s, e);

    // Accumulate every allocation at FULL precision; round once per figure.
    // The sections used to be summed from rounded lines, and netChange from
    // rounded sections, so the statement could sit a paisa off the ledger.
    const rawByLine = new Map<CashFlowLineKey, number>();
    for (const f of cash.flows) {
      for (const a of f.allocations) {
        rawByLine.set(a.lineKey, (rawByLine.get(a.lineKey) ?? 0) + a.amount);
      }
    }
    const toSection = (section: CashFlowSectionKey) => {
      const keys = [...rawByLine.keys()].filter(
        (k) => CASH_FLOW_LINES[k].section === section,
      );
      const raw = keys.reduce((t, k) => t + rawByLine.get(k)!, 0);
      const lines: CashFlowLine[] = keys
        // A line of ledger dust is not shown, but still counts in the total.
        .filter((k) => Math.abs(rawByLine.get(k)!) >= 0.005)
        .map((k) => ({
          label: CASH_FLOW_LINES[k].label,
          amount: r2(rawByLine.get(k)!),
          lineKey: k,
          section,
        }))
        .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));
      return { lines, total: r2(raw), raw };
    };
    const operating = toSection('operating');
    const investing = toSection('investing');
    const financing = toSection('financing');

    const rawNetChange = operating.raw + investing.raw + financing.raw;
    const netChange = r2(rawNetChange);
    const beginningCash = r2(rawBeginning);
    const endingCash = r2(rawBeginning + rawNetChange);

    const [monthlyTrend, accounts] = await Promise.all([
      this.cashMonthlyTrend(companyId, s, e, 12, rawBeginning),
      this.cashAccountBalances(companyId, s, e),
    ]);
    // The tie to the balance sheet, stated rather than assumed: the cash the
    // statement ends on against what the cash and bank accounts hold at endDate.
    const rawBalanceSheetCash = accounts.reduce((t, a) => t + a.rawEnding, 0);

    // Cash in and cash out by month, over the trend's months, from the same
    // classified postings as the sections. A transfer between the company's
    // own cash and bank accounts is in neither column — it moves cash without
    // bringing any in or sending any out — so in − out is each month's net.
    const inOut = new Map<string, { inflow: number; outflow: number }>();
    for (const f of cash.flows) {
      if (f.transfer) continue;
      const amount = f.allocations.reduce((t, a) => t + a.amount, 0);
      if (Math.abs(amount) < 1e-9) continue;
      const period = f.date.slice(0, 7);
      const slot = inOut.get(period) ?? { inflow: 0, outflow: 0 };
      if (amount > 0) slot.inflow += amount;
      else slot.outflow -= amount;
      inOut.set(period, slot);
    }
    const monthly: CashFlowMonth[] = monthlyTrend.map((p) => {
      const io = inOut.get(p.period) ?? { inflow: 0, outflow: 0 };
      return {
        period: p.period,
        label: p.label,
        inflow: r2(io.inflow),
        outflow: r2(io.outflow),
        net: r2(io.inflow - io.outflow),
        endingCash: p.endingCash,
      };
    });

    const operatingIndirect = await this.buildOperatingIndirect(
      companyId,
      s,
      e,
      operating.raw,
      cash,
    );

    return {
      range: { startDate: s, endDate: e },
      operating: { lines: operating.lines, total: operating.total },
      investing: { lines: investing.lines, total: investing.total },
      financing: { lines: financing.lines, total: financing.total },
      netChange,
      beginningCash,
      endingCash,
      // `period`/`rawValue` are internal (the analytics series uses them).
      monthlyTrend: monthlyTrend.map(({ label, value, endingCash }) => ({
        label,
        value,
        endingCash,
      })),
      operatingIndirect,
      // ── additive (v2) ──
      accounts: accounts.map((a) => ({
        accountCode: a.accountCode,
        accountName: a.accountName,
        beginning: a.beginning,
        ending: a.ending,
      })),
      cashTie: {
        endingCash,
        balanceSheetCash: r2(rawBalanceSheetCash),
        ties:
          Math.abs(rawBeginning + rawNetChange - rawBalanceSheetCash) < 0.005,
      },
      monthly,
    };
  }

  /**
   * Revenue and expense figures over GL rows at FULL precision, split by
   * exactly the rules profitLoss applies (isCogs, isOther). The analytics
   * series sums these month by month; profitLoss rounds the same sums for the
   * range, so the two agree by construction.
   */
  pnlRaw(
    rows: Array<{
      type: string;
      dr: string;
      cr: string;
      accountNumber: string;
      subType: string;
    }>,
  ) {
    let revenue = 0;
    let income = 0;
    let cogs = 0;
    let opex = 0;
    let otherExpense = 0;
    for (const row of rows) {
      const dr = num(row.dr);
      const cr = num(row.cr);
      if (row.type === 'revenue') {
        revenue += cr - dr;
        if (!this.isOther(row)) income += cr - dr;
      } else if (row.type === 'expense') {
        if (this.isCogs(row)) cogs += dr - cr;
        else if (this.isOther(row)) otherExpense += dr - cr;
        else opex += dr - cr;
      }
    }
    const expenses = opex + otherExpense;
    return {
      revenue,
      income,
      cogs,
      grossProfit: revenue - cogs,
      operatingExpenses: opex,
      expenses,
      netIncome: revenue - cogs - expenses,
    };
  }

  /** pnlRaw for every calendar month touched by [s, e], one query. */
  async pnlByMonth(companyId: string, s: string, e: string) {
    const rows = await this.dataSource.query(
      `SELECT to_char(g.date, 'YYYY-MM') AS period,
              a.account_number AS "accountNumber", a.type, a.sub_type AS "subType",
              COALESCE(SUM(g.debit::numeric), 0) AS dr,
              COALESCE(SUM(g.credit::numeric), 0) AS cr
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id = $1 AND g.date >= $2 AND g.date <= $3
          AND a.type IN ('revenue', 'expense')
        GROUP BY period, a.account_number, a.type, a.sub_type`,
      [companyId, s, e],
    );
    const byPeriod = new Map<string, any[]>();
    for (const r of rows ?? [])
      byPeriod.set(r.period, [...(byPeriod.get(r.period) ?? []), r]);
    return new Map(
      [...byPeriod.entries()].map(([period, rs]) => [period, this.pnlRaw(rs)]),
    );
  }

  /** Direct-method operating cash per calendar month, at full precision. */
  async operatingCashByMonth(companyId: string, s: string, e: string) {
    const { flows } = await this.classifyCashPostings(companyId, s, e);
    const out = new Map<string, number>();
    for (const f of flows) {
      const op = f.allocations
        .filter((a) => CASH_FLOW_LINES[a.lineKey].section === 'operating')
        .reduce((t, a) => t + a.amount, 0);
      if (op)
        out.set(f.date.slice(0, 7), (out.get(f.date.slice(0, 7)) ?? 0) + op);
    }
    return out;
  }

  /**
   * Every posting that moved cash in the range, whole, with its cash
   * classified. Two set-based queries, never one per posting:
   *
   *  1. the references of in-range Cash/Bank rows, and every row of those
   *     postings — the siblings that say what the cash was for;
   *  2. for bill payments, the bills each one paid and those bills' posted
   *     debit lines — what the supplier was actually paid for (D2).
   *
   * Shared by the statement, its line drill-down and the analytics series, so
   * a figure and the rows behind it cannot disagree.
   */
  private async classifyCashPostings(
    companyId: string,
    s: string,
    e: string,
  ): Promise<{ postings: Map<string, Posting>; flows: PostingCashFlow[] }> {
    const rows = await this.dataSource.query(
      `WITH cash_refs AS (
         SELECT DISTINCT g.reference
           FROM general_ledger g
           JOIN accounts a ON a.id = g.account_id
          WHERE g.company_id = $1 AND a.sub_type IN ('Cash','Bank')
            AND g.date >= $2 AND g.date <= $3
       )
       SELECT g.id, g.reference, g.date::text AS date,
              g.source_type AS "sourceType", g.source_id AS "sourceId",
              a.account_number AS "accountCode", a.name AS "accountName",
              a.type, a.sub_type AS "subType",
              (g.debit::numeric - g.credit::numeric) AS amount
         FROM general_ledger g
         JOIN cash_refs r ON r.reference = g.reference
         JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id = $1
        ORDER BY g.date, g.reference, g.created_at, g.id`,
      [companyId, s, e],
    );
    const postings = this.toPostings(rows);

    const paymentIds = [...postings.values()]
      .filter((p) => p.sourceType === 'bill_payment')
      .map((p) => p.sourceId);
    const lookThrough = await this.billPaymentLookThrough(
      companyId,
      paymentIds,
    );

    const flows = [...postings.values()].map((p) =>
      classifyPosting(
        p,
        p.sourceType === 'bill_payment'
          ? (lookThrough.get(p.sourceId) ?? [])
          : undefined,
      ),
    );
    return { postings, flows };
  }

  /** GL rows (with account columns) grouped into postings by reference. */
  private toPostings(rows: any[]): Map<string, Posting> {
    const postings = new Map<string, Posting>();
    for (const r of rows ?? []) {
      let p = postings.get(r.reference);
      if (!p) {
        p = {
          reference: r.reference,
          date: toIsoDay(r.date) ?? String(r.date),
          sourceType: r.sourceType,
          sourceId: r.sourceId,
          rows: [],
        };
        postings.set(r.reference, p);
      }
      const row: LedgerRow = {
        id: r.id,
        accountCode: r.accountCode,
        accountName: r.accountName,
        type: r.type,
        subType: r.subType ?? null,
        amount: num(r.amount),
        isCash: r.subType === 'Cash' || r.subType === 'Bank',
      };
      p.rows.push(row);
    }
    return postings;
  }

  /**
   * What each bill payment paid FOR: every bill it was applied to, weighted by
   * the amount applied, spread across that bill's posted DEBIT lines in
   * proportion. Read from the bill's own posting rather than its line items,
   * so tax posted to 1300 and GRNI variance are weighted exactly as they were
   * booked. A posted bill is immutable, so `('bill', bill.id)` is one posting.
   */
  private async billPaymentLookThrough(
    companyId: string,
    paymentIds: string[],
  ): Promise<Map<string, LookThroughWeight[]>> {
    const out = new Map<string, LookThroughWeight[]>();
    if (!paymentIds.length) return out;
    const rows = await this.dataSource.query(
      `SELECT bpa.id AS "applicationId", bpa.bill_payment_id AS "paymentId",
              bpa.amount::numeric AS applied,
              a.account_number AS "accountCode", a.type, a.sub_type AS "subType",
              COALESCE(SUM(g.debit::numeric), 0) AS debit
         FROM bill_payment_applications bpa
         LEFT JOIN general_ledger g
                ON g.company_id = $1 AND g.source_type = 'bill'
               AND g.source_id = bpa.bill_id AND g.debit::numeric > 0
         LEFT JOIN accounts a ON a.id = g.account_id
        WHERE bpa.bill_payment_id = ANY($2::uuid[])
        GROUP BY bpa.id, bpa.bill_payment_id, bpa.amount, a.account_number, a.type, a.sub_type`,
      [companyId, paymentIds],
    );
    // Total debits per application, to turn each line into a share of it.
    const debitsByApp = new Map<string, number>();
    for (const r of rows) {
      debitsByApp.set(
        r.applicationId,
        (debitsByApp.get(r.applicationId) ?? 0) + num(r.debit),
      );
    }
    for (const r of rows) {
      const list = out.get(r.paymentId) ?? [];
      const applied = num(r.applied);
      const totalDebits = debitsByApp.get(r.applicationId) ?? 0;
      if (totalDebits > EPS && r.accountCode) {
        list.push({
          type: r.type,
          subType: r.subType ?? null,
          accountCode: r.accountCode,
          weight: applied * (num(r.debit) / totalDebits),
        });
      } else if (
        !list.some((w) => w.accountCode === '' && w.weight === applied)
      ) {
        // A bill with no posting to look through to: the supplier line keeps it.
        list.push({
          type: 'liability',
          subType: 'Accounts Payable',
          accountCode: '',
          weight: applied,
        });
      }
      out.set(r.paymentId, list);
    }
    return out;
  }

  /**
   * Net cash movement month by month, zero-filled: every calendar month in the
   * range, then the last twelve — the same length the trend always had, but a
   * quiet month is a zero bar rather than a missing one. Each point also
   * carries the cash held at that month's end, so a chart needs no running sum.
   */
  /**
   * @param beginning cash before `s` at full precision, when the caller has it
   *   (cashFlow does); otherwise it is read here. Only the range itself is
   *   scanned month by month — the history before it is one figure.
   */
  async cashMonthlyTrend(
    companyId: string,
    s: string,
    e: string,
    maxMonths = 12,
    beginning?: number,
  ) {
    const [rows, opening] = await Promise.all([
      this.dataSource.query(
        `SELECT to_char(g.date, 'YYYY-MM') AS period,
                COALESCE(SUM(g.debit::numeric - g.credit::numeric), 0) AS v
           FROM general_ledger g JOIN accounts a ON a.id = g.account_id
          WHERE g.company_id = $1 AND a.sub_type IN ('Cash','Bank')
            AND g.date >= $2 AND g.date <= $3
          GROUP BY period
          ORDER BY period`,
        [companyId, s, e],
      ),
      beginning !== undefined
        ? Promise.resolve(beginning)
        : this.cashBefore(companyId, s),
    ]);
    const window = monthWindow(
      e,
      Math.min(Math.max(monthSpan(s, e), 1), maxMonths),
    );
    const byPeriod = new Map<string, any>(
      (rows ?? []).map((r: any) => [r.period as string, r]),
    );
    // Cash at the window's start: everything before the range, plus the
    // range's months that fall before the window.
    let running = opening;
    for (const r of rows ?? [])
      if ((r.period as string) < window[0].period) running += num(r.v);
    return window.map((slot) => {
      const r = byPeriod.get(slot.period);
      running += num(r?.v);
      return {
        label: slot.label,
        value: r2(num(r?.v)),
        endingCash: r2(running),
        period: slot.period,
        rawValue: num(r?.v),
      };
    });
  }

  /** Cash + Bank before a date, at full precision. */
  private async cashBefore(companyId: string, s: string): Promise<number> {
    const rows = await this.dataSource.query(
      `SELECT COALESCE(SUM(g.debit::numeric - g.credit::numeric),0) AS v
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id=$1 AND a.sub_type IN ('Cash','Bank') AND g.date < $2`,
      [companyId, s],
    );
    return num(rows?.[0]?.v);
  }

  /** Each cash and bank account at the start and end of the range. */
  private async cashAccountBalances(
    companyId: string,
    s: string,
    e: string,
  ): Promise<Array<CashFlowAccount & { rawEnding: number }>> {
    const rows = await this.dataSource.query(
      `SELECT a.account_number AS "accountCode", a.name AS "accountName",
              COALESCE(SUM(g.debit::numeric - g.credit::numeric)
                       FILTER (WHERE g.date < $2), 0) AS beginning,
              COALESCE(SUM(g.debit::numeric - g.credit::numeric), 0) AS ending
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id = $1 AND a.sub_type IN ('Cash','Bank') AND g.date <= $3
        GROUP BY a.account_number, a.name
        ORDER BY a.account_number`,
      [companyId, s, e],
    );
    return (rows ?? []).map((r: any) => ({
      accountCode: r.accountCode,
      accountName: r.accountName,
      beginning: r2(num(r.beginning)),
      ending: r2(num(r.ending)),
      rawEnding: num(r.ending),
    }));
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
   * Working capital here is CURRENT assets and liabilities only. Fixed assets,
   * long-term loans and equity are investing and financing, and their cash is
   * already in those sections; counting their balance changes here as well
   * would put a machine purchase into operating cash a second time.
   *
   * Non-cash transactions are left out (IAS 7.43): opening balances and
   * opening stock entered during the period, assets bought on credit, the AP a
   * capex bill payment clears, expenses the owner paid personally. Each moves
   * a working-capital account or net income with no cash, so leaving them in
   * puts a figure in the walk that the direct method — rightly — never sees.
   * What was removed is listed in `excludedNonCash`, not hidden.
   *
   * Reads only; nothing here posts.
   */
  private async buildOperatingIndirect(
    companyId: string,
    s: string,
    e: string,
    directOperatingRaw: number,
    cash: { postings: Map<string, Posting>; flows: PostingCashFlow[] },
  ): Promise<OperatingIndirect> {
    // A balance's change over the period is its movement in the period —
    // closing less opening, without reading either: two passes over the whole
    // history, on a ledger with years of it, cost more than everything else
    // here together. glByAccount lists every account, moved or not.
    const [periodRows, nonCash] = await Promise.all([
      this.glByAccount(companyId, s, e),
      this.nonCashMovements(companyId, s, e, cash),
    ]);
    const movement = new Map(
      periodRows.map((r) => {
        const dr = num(r.dr);
        const cr = num(r.cr);
        const moved =
          r.type === 'asset' || r.type === 'expense' ? dr - cr : cr - dr;
        return [
          r.accountNumber,
          { type: r.type, subType: r.subType, moved },
        ] as const;
      }),
    );

    const netIncome = this.netIncomeFrom(periodRows);
    const rawNetIncome = this.earningsOf(periodRows).raw;

    /** A balance's change over the period, less what moved it without cash. */
    const delta = (
      pick: (code: string, meta: { type: string; subType: string }) => boolean,
    ): number => {
      let d = 0;
      for (const [code, meta] of movement) {
        if (!pick(code, meta)) continue;
        // `excluded` is debit-positive; movements are normal-balance signed.
        const moved = nonCash.excluded.get(code) ?? 0;
        const movedNormal =
          meta.type === 'asset' || meta.type === 'expense' ? moved : -moved;
        d += meta.moved - movedNormal;
      }
      return d;
    };

    const isCashLike = (m: { subType: string }) =>
      m.subType === 'Cash' || m.subType === 'Bank';
    const inRange = (code: string, lo: number, hi: number) => {
      const n = parseInt(code, 10);
      return Number.isFinite(n) && n >= lo && n <= hi;
    };
    const groupOf = (code: string, m: { type: string; subType: string }) =>
      classifyForStatement(m.type, m.subType, code);

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
    const dPrepaid = delta(
      (c, m) =>
        m.type === 'asset' &&
        m.subType === 'Prepaid' &&
        !inRange(c, 1200, 1299),
    );
    // Fixed assets are investing, not working capital.
    const dOtherAssets = delta(
      (c, m) =>
        m.type === 'asset' &&
        !isCashLike(m) &&
        m.subType !== 'Accounts Receivable' &&
        m.subType !== 'Prepaid' &&
        !inRange(c, 1200, 1299) &&
        groupOf(c, m) !== 'fixedAssets',
    );
    const dAP = delta(
      (_c, m) => m.type === 'liability' && m.subType === 'Accounts Payable',
    );
    const dGrni = delta((c) => c === '2050');
    // Long-term loans are financing, not working capital.
    const dOtherLiabs = delta(
      (c, m) =>
        m.type === 'liability' &&
        m.subType !== 'Accounts Payable' &&
        c !== '2050' &&
        groupOf(c, m) !== 'longTermLiabilities',
    );
    const depreciation = delta(
      (_c, m) => m.type === 'expense' && m.subType === 'Depreciation',
    );

    // An asset going UP consumes cash; a liability going UP releases it.
    const candidates: CashFlowLine[] = [
      { label: 'Depreciation & amortisation', amount: depreciation },
      { label: 'Other non-cash items', amount: nonCash.addBack },
      { label: 'Accounts Receivable', amount: -dAR },
      { label: 'Inventory', amount: -dInventory },
      { label: 'Goods in Transit', amount: -dGit },
      { label: 'Prepaid expenses', amount: -dPrepaid },
      { label: 'Other current assets', amount: -dOtherAssets },
      { label: 'Accounts Payable', amount: dAP },
      { label: 'Goods Received Not Invoiced', amount: dGrni },
      { label: 'Other current liabilities', amount: dOtherLiabs },
    ].filter((l) => Math.abs(l.amount) > 0.005);

    // Whether anything is left unexplained is decided on RAW figures. The
    // displayed adjustments are then rounded so that, with net income, they
    // foot to the displayed total exactly — a residual line appears only for
    // a real residual, never for a paisa of presentation rounding.
    const rawSubtotal =
      rawNetIncome + candidates.reduce((t, l) => t + l.amount, 0);
    const rawResidual = directOperatingRaw - rawSubtotal;
    const total = r2(directOperatingRaw);
    const hasResidual = Math.abs(rawResidual) >= 0.005;
    const rounded = apportionRounding(
      candidates.map((l) => l.amount),
      r2(total - netIncome - (hasResidual ? r2(rawResidual) : 0)),
    );
    const adjustments: CashFlowLine[] = candidates.map((l, i) => ({
      label: l.label,
      amount: rounded[i],
    }));
    if (hasResidual) {
      adjustments.push({
        label: 'Other operating adjustments',
        amount: r2(rawResidual),
      });
    }

    return {
      netIncome,
      adjustments,
      total,
      excludedNonCash: nonCash.breakdown,
    };
  }

  /**
   * The non-cash part of the period's postings, for the indirect method: per
   * account, the debit-positive movement that no cash accompanied, and the
   * P&L amount to add back. Candidates are found in ONE query — postings
   * touching an opening position, equity, a fixed asset or a long-term loan —
   * plus the bill payments the cash classification already looked through to a
   * capex bill. The share of each row is decided in nonCashShares.
   */
  private async nonCashMovements(
    companyId: string,
    s: string,
    e: string,
    cash: { postings: Map<string, Posting>; flows: PostingCashFlow[] },
  ): Promise<{
    excluded: Map<string, number>;
    addBack: number;
    breakdown: CashFlowLine[];
  }> {
    const rows = await this.dataSource.query(
      `WITH candidates AS (
         SELECT g.reference
           FROM general_ledger g
           JOIN accounts a ON a.id = g.account_id
          WHERE g.company_id = $1 AND g.date >= $2 AND g.date <= $3
          GROUP BY g.reference
         HAVING bool_or(g.source_type IN ('opening_balance', 'opening_stock'))
             OR bool_or(a.type = 'equity')
             OR bool_or(a.type = 'asset' AND (
                  a.sub_type = 'Fixed Asset'
                  OR COALESCE(a.sub_type, '') NOT IN
                     ('Cash','Bank','Accounts Receivable','Inventory','Prepaid','Fixed Asset','Other Asset')
                  OR (a.sub_type = 'Other Asset' AND a.account_number ~ '^[0-9]+'
                      AND substring(a.account_number from '^[0-9]+')::bigint >= 1500)))
             OR bool_or(a.type = 'liability' AND (
                  a.sub_type = 'Notes Payable'
                  OR COALESCE(a.sub_type, '') NOT IN
                     ('Accounts Payable','Credit Card','Payroll Liability','Tax Payable','Other Liability','Notes Payable')))
       )
       SELECT g.id, g.reference, g.date::text AS date,
              g.source_type AS "sourceType", g.source_id AS "sourceId",
              a.account_number AS "accountCode", a.name AS "accountName",
              a.type, a.sub_type AS "subType",
              (g.debit::numeric - g.credit::numeric) AS amount
         FROM general_ledger g
         JOIN candidates c ON c.reference = g.reference
         JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id = $1`,
      [companyId, s, e],
    );
    const postings = this.toPostings(rows);
    const flowByRef = new Map(cash.flows.map((f) => [f.reference, f]));
    for (const f of cash.flows) {
      const p = cash.postings.get(f.reference);
      if (!p || postings.has(f.reference) || f.sourceType !== 'bill_payment')
        continue;
      if (
        f.allocations.some(
          (a) => CASH_FLOW_LINES[a.lineKey].section !== 'operating',
        )
      ) {
        postings.set(f.reference, p);
      }
    }

    const excluded = new Map<string, number>();
    let addBack = 0;
    const effect = { opening: 0, payables: 0, other: 0 };
    for (const p of postings.values()) {
      const shares = nonCashShares(p, flowByRef.get(p.reference));
      for (const r of p.rows) {
        const share = shares.get(r.id);
        if (!share) continue;
        const moved = r.amount * share;
        if (r.type === 'revenue' || r.type === 'expense') {
          // Depreciation has its own add-back line; never count it twice.
          if (r.subType === 'Depreciation') continue;
          addBack += moved;
          continue;
        }
        excluded.set(r.accountCode, (excluded.get(r.accountCode) ?? 0) + moved);
        // What the movement would have done to the walk, had it stayed in.
        const bucket = OPENING_SOURCE_TYPES.has(p.sourceType)
          ? 'opening'
          : p.sourceType === 'bill_payment'
            ? 'payables'
            : 'other';
        effect[bucket] -= moved;
      }
    }
    const breakdown: CashFlowLine[] = [
      {
        label: 'Opening balances and opening stock entered in the period',
        amount: effect.opening,
      },
      {
        label: 'Payables settled for fixed assets (investing)',
        amount: effect.payables,
      },
      { label: 'Non-cash investing and financing', amount: effect.other },
    ]
      .filter((l) => Math.abs(l.amount) >= 0.005)
      .map((l) => ({ label: l.label, amount: r2(l.amount) }));
    return { excluded, addBack, breakdown };
  }

  toCsv(rows: Record<string, unknown>[]): string {
    if (!rows.length) return '';
    const keys = Object.keys(rows[0]);
    const header = keys.join(',');
    const lines = rows.map((r) =>
      keys.map((k) => `"${String(r[k] ?? '').replace(/"/g, '""')}"`).join(','),
    );
    return [header, ...lines].join('\n');
  }
}
