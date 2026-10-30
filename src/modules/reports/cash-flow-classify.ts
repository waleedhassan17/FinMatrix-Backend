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
 *  1. A posting with no non-cash rows is a TRANSFER between the company's own
 *     accounts: it nets to zero and appears in no section.
 *  2. Cash is matched GROSS. Cash coming in (debits to Cash/Bank) came from
 *     the posting's non-cash CREDIT rows; cash going out (credits to Cash/Bank)
 *     went to its non-cash DEBIT rows — each in proportion to the rows'
 *     amounts, up to what those rows can absorb. Netting first and allocating
 *     the net would be exact only while cash sits on one side; a compound
 *     journal — a day's bank book with receipts, payments and a loan
 *     instalment in one entry — has it on both, and netting mixes unrelated
 *     receipts and payments. Whatever of a non-cash row is not matched to cash
 *     is the non-cash part of the transaction (IAS 7.43): payroll's withheld
 *     tax, the part of a machine the bank financed directly. It receives no
 *     cash. Cash in beyond what the credit rows can absorb is matched by cash
 *     out on the other side: money moved between the company's own accounts
 *     inside the entry, in no section.
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
  /** Signed cash, full precision: inflow less outflow. Σ over a posting = its netCash. */
  amount: number;
  /** 0..1 share of the posting's cash IN (its debit Cash/Bank rows) matched to this line. */
  inPct: number;
  /** 0..1 share of the posting's cash OUT (its credit Cash/Bank rows) matched to this line. */
  outPct: number;
}

/**
 * The share of one cash row that a line received: a receipt row shares in
 * what came in, a payment row in what went out. A row's allocated cash is
 * `row.amount × cashRowShare(row, allocation)`, and those add up, over every
 * cash row of every posting, to the line's amount.
 */
export const cashRowShare = (
  row: { amount: number },
  a: CashAllocation,
): number => (row.amount >= 0 ? a.inPct : a.outPct);

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
  const cashIn = cashRows.reduce(
    (t, r) => (r.amount > 0 ? t + r.amount : t),
    0,
  );
  const cashOut = cashRows.reduce(
    (t, r) => (r.amount < 0 ? t - r.amount : t),
    0,
  );
  const netCash = cashIn - cashOut;
  const base = {
    reference: p.reference,
    date: p.date,
    sourceType: p.sourceType,
    sourceId: p.sourceId,
    netCash,
    cashRows,
  };
  if (!nonCash.length) return { ...base, transfer: true, allocations: [] };
  if (cashIn <= EPS && cashOut <= EPS) {
    return { ...base, transfer: false, allocations: [] };
  }

  const opLine = operatingLineFor(p.sourceType);
  if (p.sourceType === 'opening_balance') {
    return {
      ...base,
      transfer: false,
      allocations: [
        {
          lineKey: 'fin.opening_balance',
          amount: netCash,
          inPct: cashIn > EPS ? 1 : 0,
          outPct: cashOut > EPS ? 1 : 0,
        },
      ],
    };
  }

  const debits = nonCash.filter((r) => r.amount > EPS);
  const credits = nonCash.filter((r) => r.amount < -EPS);
  const debitTotal = debits.reduce((t, r) => t + r.amount, 0);
  const creditTotal = credits.reduce((t, r) => t - r.amount, 0);
  // What each side can absorb: cash in is matched to the credit rows, cash
  // out to the debit rows. In a balanced posting the excess of each is the
  // same figure — money that moved between the company's own accounts.
  const inflow = Math.min(cashIn, creditTotal);
  const outflow = Math.min(cashOut, debitTotal);

  /** Weights per line for one side's rows; a bill payment's AP is looked through. */
  const weigh = (rows: LedgerRow[]) => {
    const w = new Map<CashFlowLineKey, number>();
    const add = (k: CashFlowLineKey, v: number) =>
      w.set(k, (w.get(k) ?? 0) + v);
    for (const r of rows) {
      const size = Math.abs(r.amount);
      if (
        lookThrough &&
        p.sourceType === 'bill_payment' &&
        r.subType === 'Accounts Payable'
      ) {
        const covered = lookThrough.reduce((t, x) => t + x.weight, 0);
        if (covered > EPS) {
          // Applications can never exceed the payment; scale down defensively.
          const scale = covered > size ? size / covered : 1;
          for (const x of lookThrough)
            add(nonOperatingLineFor(x) ?? opLine, x.weight * scale);
          const unapplied = size - covered * scale;
          if (unapplied > EPS) add(opLine, unapplied);
          continue;
        }
      }
      add(nonOperatingLineFor(r) ?? opLine, size);
    }
    return w;
  };
  const spread = (w: Map<CashFlowLineKey, number>, cash: number) => {
    const total = [...w.values()].reduce((t, v) => t + v, 0);
    return new Map(
      [...w.entries()].map(([k, v]) => [
        k,
        total > EPS ? cash * (v / total) : 0,
      ]),
    );
  };
  const lineIn = spread(weigh(credits), inflow);
  const lineOut = spread(weigh(debits), outflow);

  const keys = new Set<CashFlowLineKey>([...lineIn.keys(), ...lineOut.keys()]);
  const allocations: CashAllocation[] = [...keys].map((lineKey) => {
    const i = lineIn.get(lineKey) ?? 0;
    const o = lineOut.get(lineKey) ?? 0;
    return {
      lineKey,
      amount: i - o,
      inPct: cashIn > EPS ? i / cashIn : 0,
      outPct: cashOut > EPS ? o / cashOut : 0,
    };
  });

  // A balanced posting is fully explained above. An unbalanced one should not
  // exist, but if it does its cash must still land somewhere, or the sections
  // stop adding up to the net change: the remainder goes to the operating line.
  const explained = allocations.reduce((t, a) => t + a.amount, 0);
  const remainder = netCash - explained;
  if (Math.abs(remainder) > EPS) {
    let a = allocations.find((x) => x.lineKey === opLine);
    if (!a)
      allocations.push(
        (a = { lineKey: opLine, amount: 0, inPct: 0, outPct: 0 }),
      );
    a.amount += remainder;
    if (remainder > 0) a.inPct += cashIn > EPS ? remainder / cashIn : 0;
    else a.outPct += cashOut > EPS ? -remainder / cashOut : 0;
  }

  return {
    ...base,
    transfer: false,
    allocations: allocations.filter(
      (a) => Math.abs(a.amount) > EPS || a.inPct > 0 || a.outPct > 0,
    ),
  };
}

/**
 * For the INDIRECT method: the share of each operating non-cash row (working
 * capital, revenue, expense) in a posting that is NOT an operating cash event,
 * so working capital and net income can be cleansed of it (IAS 7.43 —
 * investing and financing transactions that use no cash are excluded).
 *
 *  - Opening positions (opening balances, opening stock) entered in the period
 *    are not period activity at all: share 1. Entering 150,000 of opening
 *    stock is not 150,000 of cash spent on inventory.
 *  - Otherwise each row splits as classifyPosting splits it: the part matched
 *    to cash, and the non-cash rest. The cash part is an operating cash event
 *    and stays. The non-cash rests of a posting form a balanced transaction of
 *    their own; a row's non-cash rest is excluded in the proportion that the
 *    other side of THAT transaction is a fixed asset, a long-term loan or
 *    equity. A machine bought on credit (Dr Fixed Asset / Cr AP) takes the AP
 *    increase out of working capital; inventory bought half with cash and half
 *    with a direct loan keeps only the cash half.
 *  - A bill payment's AP row: its cash part takes the look-through's
 *    non-operating share — paying the supplier of a machine is investing, so
 *    the AP it clears is too.
 *
 * Because the two methods read each posting through the same split, the
 * indirect walk reaches the direct operating figure exactly, posting by
 * posting — compound entries included.
 *
 * Rows that are themselves cash or non-operating are not returned; they never
 * feed the indirect method's working capital.
 */
export function nonCashShares(
  p: Posting,
  flow?: PostingCashFlow,
): Map<string, number> {
  const out = new Map<string, number>();
  const operating = p.rows.filter(
    (r) => !r.isCash && nonOperatingLineFor(r) === null,
  );

  if (OPENING_SOURCE_TYPES.has(p.sourceType)) {
    for (const r of operating) out.set(r.id, 1);
    return out;
  }

  const cash = p.rows.filter((r) => r.isCash);
  const nonCash = p.rows.filter((r) => !r.isCash);
  const cashIn = cash.reduce((t, r) => (r.amount > 0 ? t + r.amount : t), 0);
  const cashOut = cash.reduce((t, r) => (r.amount < 0 ? t - r.amount : t), 0);
  const debitTotal = nonCash.reduce(
    (t, r) => (r.amount > EPS ? t + r.amount : t),
    0,
  );
  const creditTotal = nonCash.reduce(
    (t, r) => (r.amount < -EPS ? t - r.amount : t),
    0,
  );
  /** The share of a non-cash row that was matched to cash. */
  const matched = (r: LedgerRow) =>
    r.amount > 0
      ? debitTotal > EPS
        ? Math.min(1, cashOut / debitTotal)
        : 0
      : creditTotal > EPS
        ? Math.min(1, cashIn / creditTotal)
        : 0;

  // A looked-through bill payment: the non-operating share of its cash out.
  const lookedThrough =
    flow && p.sourceType === 'bill_payment' && cashOut > EPS
      ? flow.allocations
          .filter((a) => CASH_FLOW_LINES[a.lineKey].section !== 'operating')
          .reduce((t, a) => t + a.outPct, 0) *
        (cashOut / Math.max(Math.min(cashOut, debitTotal), EPS))
      : 0;

  for (const r of operating) {
    if (Math.abs(r.amount) <= EPS) continue;
    const m = matched(r);
    // The other side of the posting's non-cash transaction.
    const opposite = nonCash.filter(
      (o) =>
        o !== r &&
        Math.sign(o.amount) === -Math.sign(r.amount) &&
        Math.abs(o.amount) > EPS,
    );
    const rest = (o: LedgerRow) => (1 - matched(o)) * Math.abs(o.amount);
    const all = opposite.reduce((t, o) => t + rest(o), 0);
    const nonOp = opposite
      .filter((o) => nonOperatingLineFor(o) !== null)
      .reduce((t, o) => t + rest(o), 0);
    let share = all > EPS ? (1 - m) * (nonOp / all) : 0;
    if (lookedThrough > 0 && r.subType === 'Accounts Payable')
      share += m * Math.min(1, lookedThrough);
    if (share > EPS) out.set(r.id, Math.min(1, share));
  }
  return out;
}
