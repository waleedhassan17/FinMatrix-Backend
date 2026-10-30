/**
 * Cash-flow classification by COUNTERPART, not by document type.
 *
 * The statement used to label cash by the `source_type` of the posting that
 * moved it. That works for trade — a customer receipt is a customer receipt —
 * and fails for everything else: a machine paid for with a bill was "cash paid
 * to suppliers", and a bank loan or the owner's capital, both posted as journal
 * entries, were "other cash movements" inside OPERATING. The operating figure
 * was overstated or understated whenever the business invested or borrowed.
 *
 * The question that decides a section is what the cash was exchanged FOR, and
 * the ledger answers it: the other lines of the same posting. A posting is
 * every general_ledger row sharing `(company_id, reference)` — `reference` is
 * the journal-entry number, unique per company, and the one key that groups a
 * posting's lines (source_type/source_id repeat across postings, created_at is
 * shared by a whole transaction).
 *
 * The rules, per posting:
 *
 *  1. netCash = Σ(debit − credit) over its Cash/Bank rows. A posting with no
 *     non-cash rows is a TRANSFER between the company's own accounts: it nets
 *     to zero and appears in no section.
 *  2. netCash is allocated across the non-cash rows on the OPPOSITE side to it
 *     — what the cash paid for, or came from — in proportion to their amounts.
 *     Non-cash rows on the SAME side as the cash are the non-cash part of the
 *     transaction (IAS 7.43): payroll's withheld tax, the part of a machine the
 *     bank financed directly. They receive no cash. Allocating across every
 *     sibling instead would send a positive figure to "tax" for every payroll
 *     run.
 *  3. Each receiving row is classified by its account: fixed assets →
 *     investing; Notes Payable → financing (loans); owner/other/opening-balance
 *     equity → financing (contributions); Owner Draws and Retained Earnings →
 *     financing (drawings). Anything else is operating, under the line its
 *     source_type has always carried, so trade lines keep their labels.
 *  4. Two exceptions. A posting whose source_type is `opening_balance` is an
 *     opening position, not a period flow, and keeps its own financing line as
 *     it always has. A `bill_payment` debits Accounts Payable, which says
 *     nothing about what was bought — so the AP row is looked through to the
 *     bills it paid and their posted debit lines (the D2 rule: proportional).
 *
 * Pure functions only: the SQL lives in ReportsService.
 */
import { classifyForStatement } from './statement-groups';

export type CashFlowSectionKey = 'operating' | 'investing' | 'financing';

export type CashFlowLineKey =
  | 'op.customers'
  | 'op.customer_refunds'
  | 'op.suppliers'
  | 'op.vendor_refunds'
  | 'op.payroll'
  | 'op.tax'
  | 'op.other'
  | 'inv.fixed_assets'
  | 'fin.loans'
  | 'fin.owner_contributions'
  | 'fin.owner_drawings'
  | 'fin.opening_balance';

/**
 * Every line the direct method can show. The operating labels are the ones the
 * statement has always printed, so a client matching on them keeps working.
 */
export const CASH_FLOW_LINES: Record<
  CashFlowLineKey,
  { label: string; section: CashFlowSectionKey }
> = {
  'op.customers': {
    label: 'Cash received from customers',
    section: 'operating',
  },
  'op.customer_refunds': { label: 'Customer refunds', section: 'operating' },
  'op.suppliers': { label: 'Cash paid to suppliers', section: 'operating' },
  'op.vendor_refunds': {
    label: 'Vendor refunds received',
    section: 'operating',
  },
  'op.payroll': { label: 'Payroll paid', section: 'operating' },
  'op.tax': { label: 'Tax payments', section: 'operating' },
  'op.other': { label: 'Other cash movements', section: 'operating' },
  'inv.fixed_assets': {
    label: 'Purchase / sale of fixed assets',
    section: 'investing',
  },
  'fin.loans': { label: 'Loan proceeds / repayments', section: 'financing' },
  'fin.owner_contributions': {
    label: 'Owner contributions',
    section: 'financing',
  },
  'fin.owner_drawings': { label: 'Owner drawings', section: 'financing' },
  'fin.opening_balance': {
    label: 'Opening balance / owner funding',
    section: 'financing',
  },
};

export const isCashFlowLineKey = (k: string): k is CashFlowLineKey =>
  Object.prototype.hasOwnProperty.call(CASH_FLOW_LINES, k);

/**
 * The operating line for cash whose counterpart is an operating account —
 * the old source_type → label map, unchanged. Unmapped types (including the
 * *_void reversals) stay in "Other cash movements", as they always have.
 */
const OPERATING_LINE_BY_SOURCE: Record<string, CashFlowLineKey> = {
  payment: 'op.customers',
  invoice: 'op.customers',
  credit_memo: 'op.customer_refunds',
  credit_memo_refund: 'op.customer_refunds',
  bill_payment: 'op.suppliers',
  bill: 'op.suppliers',
  vendor_credit: 'op.vendor_refunds',
  payroll: 'op.payroll',
  tax_payment: 'op.tax',
  journal_entry: 'op.other',
};

export const operatingLineFor = (sourceType: string): CashFlowLineKey =>
  OPERATING_LINE_BY_SOURCE[sourceType] ?? 'op.other';

/**
 * Postings that record an opening position rather than activity in the period.
 * Their cash is the opening-balance financing line; their non-cash rows are
 * kept out of the indirect method's working capital entirely.
 */
export const OPENING_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'opening_balance',
  'opening_stock',
]);

/** Below this a figure is ledger dust: the ledger carries four decimals. */
export const EPS = 0.00005;

export interface LedgerRow {
  id: string;
  accountCode: string;
  accountName?: string;
  type: string;
  subType: string | null;
  /** debit − credit, full precision. */
  amount: number;
  isCash: boolean;
}

export interface Posting {
  reference: string;
  date: string;
  sourceType: string;
  sourceId: string;
  rows: LedgerRow[];
}

/** One weighted account behind a bill payment, from the bills it paid. */
export interface LookThroughWeight {
  type: string;
  subType: string | null;
  accountCode: string;
  /** Currency: the part of the payment attributed to this account. */
  weight: number;
}

export interface CashAllocation {
  lineKey: CashFlowLineKey;
  /** Signed cash, full precision. Σ over a posting = its netCash. */
  amount: number;
  /** 0..1 share of the posting's netCash. */
  pct: number;
}

export interface PostingCashFlow {
  reference: string;
  date: string;
  sourceType: string;
  sourceId: string;
  netCash: number;
  /** All rows are Cash/Bank: money moved between the company's own accounts. */
  transfer: boolean;
  allocations: CashAllocation[];
  cashRows: LedgerRow[];
}

/**
 * The non-operating line a counterpart account sends cash to, or null when the
 * account is operating (the line then comes from the posting's source_type).
 */
export function nonOperatingLineFor(row: {
  type: string;
  subType: string | null;
  accountCode: string;
}): CashFlowLineKey | null {
  if (row.type === 'equity') {
    return row.subType === 'Owner Draws' || row.subType === 'Retained Earnings'
      ? 'fin.owner_drawings'
      : 'fin.owner_contributions';
  }
  const group = classifyForStatement(row.type, row.subType, row.accountCode);
  if (group === 'fixedAssets') return 'inv.fixed_assets';
  if (group === 'longTermLiabilities') return 'fin.loans';
  return null;
}

/**
 * Classify one posting's cash.
 *
 * @param lookThrough for a `bill_payment`, the weighted accounts of the bills it
 *   paid (applied amount × each bill's posted debit mix). Any part of the
 *   payment they do not cover stays in "Cash paid to suppliers".
 */
export function classifyPosting(
  p: Posting,
  lookThrough?: LookThroughWeight[],
): PostingCashFlow {
  const cashRows = p.rows.filter((r) => r.isCash);
  const nonCash = p.rows.filter((r) => !r.isCash);
  const netCash = cashRows.reduce((t, r) => t + r.amount, 0);
  const base = {
    reference: p.reference,
    date: p.date,
    sourceType: p.sourceType,
    sourceId: p.sourceId,
    netCash,
    cashRows,
  };

  if (!nonCash.length || Math.abs(netCash) < EPS) {
    return { ...base, transfer: !nonCash.length, allocations: [] };
  }

  const opLine = operatingLineFor(p.sourceType);
  if (p.sourceType === 'opening_balance') {
    return {
      ...base,
      transfer: false,
      allocations: [
        { lineKey: 'fin.opening_balance', amount: netCash, pct: 1 },
      ],
    };
  }

  // What the cash paid for, or came from: the non-cash rows on the other side.
  const sign = Math.sign(netCash);
  let receiving = nonCash.filter(
    (r) => Math.sign(r.amount) === -sign && Math.abs(r.amount) > EPS,
  );
  // An unbalanced posting should not exist, but if one does its cash must
  // still land somewhere, or the sections stop adding up to the net change.
  if (!receiving.length)
    receiving = nonCash.filter((r) => Math.abs(r.amount) > EPS);

  const weights: Array<{ lineKey: CashFlowLineKey; weight: number }> = [];
  for (const r of receiving) {
    const size = Math.abs(r.amount);
    if (
      lookThrough &&
      p.sourceType === 'bill_payment' &&
      r.subType === 'Accounts Payable'
    ) {
      const covered = lookThrough.reduce((t, w) => t + w.weight, 0);
      if (covered > EPS) {
        // Applications can never exceed the payment; scale down defensively.
        const scale = covered > size ? size / covered : 1;
        for (const w of lookThrough) {
          weights.push({
            lineKey: nonOperatingLineFor(w) ?? opLine,
            weight: w.weight * scale,
          });
        }
        const unapplied = size - covered * scale;
        if (unapplied > EPS)
          weights.push({ lineKey: opLine, weight: unapplied });
        continue;
      }
    }
    weights.push({ lineKey: nonOperatingLineFor(r) ?? opLine, weight: size });
  }

  const total = weights.reduce((t, w) => t + w.weight, 0);
  const byLine = new Map<CashFlowLineKey, number>();
  for (const w of weights)
    byLine.set(w.lineKey, (byLine.get(w.lineKey) ?? 0) + w.weight);

  const allocations: CashAllocation[] =
    total > EPS
      ? [...byLine.entries()].map(([lineKey, weight]) => ({
          lineKey,
          amount: netCash * (weight / total),
          pct: weight / total,
        }))
      : [{ lineKey: opLine, amount: netCash, pct: 1 }];

  return { ...base, transfer: false, allocations };
}

/**
 * For the INDIRECT method: the share of each non-cash row in a posting that is
 * NOT an operating cash event, so working capital and net income can be
 * cleansed of it (IAS 7.43 — investing and financing transactions that use no
 * cash are excluded from the statement).
 *
 *  - Opening positions (opening balances, opening stock) entered in the period
 *    are not period activity at all: share 1. Entering 150,000 of opening
 *    stock is not 150,000 of cash spent on inventory.
 *  - Otherwise a row's share is the non-operating part of what is on the
 *    other side of it: Σ|opposite rows that are fixed assets, long-term loans
 *    or equity| ÷ Σ|all opposite rows|, cash rows included as operating. A
 *    machine bought on credit (Dr Fixed Asset / Cr AP) takes the AP increase
 *    out of working capital; inventory bought half with cash and half with a
 *    direct loan keeps only the cash half.
 *  - A bill payment's AP row takes the look-through's non-operating share: paying
 *    the supplier of a machine is investing, so the AP it clears is too.
 *
 * Rows that are themselves cash or non-operating are not returned; they never
 * feed the indirect method's working capital.
 */
export function nonCashShares(
  p: Posting,
  flow?: PostingCashFlow,
): Map<string, number> {
  const out = new Map<string, number>();
  const candidates = p.rows.filter(
    (r) => !r.isCash && nonOperatingLineFor(r) === null,
  );

  if (OPENING_SOURCE_TYPES.has(p.sourceType)) {
    for (const r of candidates) out.set(r.id, 1);
    return out;
  }

  for (const r of candidates) {
    if (Math.abs(r.amount) <= EPS) continue;
    if (
      flow &&
      p.sourceType === 'bill_payment' &&
      r.subType === 'Accounts Payable'
    ) {
      const nonOp = flow.allocations
        .filter((a) => CASH_FLOW_LINES[a.lineKey].section !== 'operating')
        .reduce((t, a) => t + a.pct, 0);
      if (nonOp > 0) out.set(r.id, Math.min(1, nonOp));
      continue;
    }
    const opposite = p.rows.filter(
      (o) =>
        o !== r &&
        Math.sign(o.amount) === -Math.sign(r.amount) &&
        Math.abs(o.amount) > EPS,
    );
    const all = opposite.reduce((t, o) => t + Math.abs(o.amount), 0);
    if (all <= EPS) continue;
    const nonOp = opposite
      .filter((o) => !o.isCash && nonOperatingLineFor(o) !== null)
      .reduce((t, o) => t + Math.abs(o.amount), 0);
    if (nonOp > EPS) out.set(r.id, nonOp / all);
  }
  return out;
}
