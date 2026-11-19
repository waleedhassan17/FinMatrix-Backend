/**
 * A Peachtree / Sage 50 company, read from its backup, as the opening
 * position FinMatrix imports — the same sheets an owner fills in the starter
 * workbook, so everything after this (mapping, issues, the checks, sign-off,
 * commit, undo) is the ordinary path.
 *
 * What Peachtree keeps, and how it is used (each point checked against a
 * real Peachtree 2015 company before it was written down):
 *
 *  - Chart: per account a beginning balance (cumulative to the start of the
 *    earliest year kept) and Dr/Cr/Net for each period of three fiscal years
 *    — last, this and next. These ARE the ledger Peachtree's reports print:
 *    the costing engine posts cost of sales into them directly, so they are
 *    the trial balance's source. Credits are negative.
 *  - General.DAT holds one record per module: AcctgModule 4 is the GL (the
 *    fiscal periods), 1 the receivables settings (control account record at
 *    2), 2 the payables settings (likewise).
 *  - Retained earnings are derived, not posted: the RE account's stored
 *    year-close figures equal the P&L of the years before. So the opening
 *    trial balance carries P&L (and "gets closed" equity) for the current
 *    fiscal year only, and RE carries everything earlier.
 *  - JrnlHdr / JrnlRow: every transaction. Journal 0 general, 1 receipts,
 *    2 payments, 3 sales (JrnlTypeEx 2 = credit memo), 4 purchases
 *    (JrnlTypeEx 3 = vendor credit), 7 inventory adjustments; 10/11 are
 *    orders and quotes, which post nothing. A row posts to the GL when
 *    IncludeInGL is set. Rows' amounts rebuild every account's stored period
 *    nets exactly — except inventory and cost of sales, whose costing amounts
 *    the rows carry as 0.
 *  - An invoice is open by MainAmount − AmountPaid; a bill by the negative of
 *    that. Each customer's and vendor's stored Balance equals its open
 *    documents exactly; the control account can differ from them by entries
 *    posted straight to it.
 *  - Items carry no quantity on hand. Quantity comes from the inventory
 *    ledger rows; item VALUES come from Peachtree's Inventory Valuation
 *    report, which the owner supplies (the costing chains are Peachtree's
 *    own and are not rebuilt here).
 *
 * Nothing here guesses: a cross-check that fails is reported, and the
 * analysis refuses the import until it passes.
 */
import Decimal from 'decimal.js';
import { readFile } from 'fs/promises';
import { SYSTEM_ACCOUNT_DEFS } from '../../../accounts/accounts.constants';
import { normalizeKey } from '../../parsers/text-normalize';
import { TARGET_SHEETS } from '../../targets';
import { BtrieveFile } from './btrieve';
import { readDictionary, TableDef } from './ddf';
import { decodeField, FieldValue } from './field-types';

export const PEACHTREE_TABLES = [
  'FILE.DDF',
  'FIELD.DDF',
  'COMPANY.DAT',
  'GENERAL.DAT',
  'CHART.DAT',
  'CUSTOMER.DAT',
  'VENDOR.DAT',
  'LINEITEM.DAT',
  'JRNLHDR.DAT',
  'JRNLROW.DAT',
  'VERSION.TXT',
] as const;

/** Peachtree account types (Chart.AccountType). */
const PT = {
  CASH: 0,
  RECEIVABLE: 1,
  INVENTORY: 2,
  OTHER_CURRENT_ASSET: 4,
  FIXED_ASSET: 5,
  ACCUMULATED_DEPRECIATION: 6,
  OTHER_ASSET: 8,
  PAYABLE: 10,
  OTHER_CURRENT_LIABILITY: 12,
  LONG_TERM_LIABILITY: 14,
  EQUITY_NO_CLOSE: 16,
  EQUITY_RETAINED: 18,
  EQUITY_CLOSES: 19,
  INCOME: 21,
  COST_OF_SALES: 23,
  EXPENSE: 24,
} as const;

/** Types whose balance closes into retained earnings at each year end. */
const CLOSES = new Set<number>([
  PT.INCOME,
  PT.COST_OF_SALES,
  PT.EXPENSE,
  PT.EQUITY_CLOSES,
]);

const JOURNAL = {
  GENERAL: 0,
  RECEIPTS: 1,
  PAYMENTS: 2,
  SALES: 3,
  PURCHASES: 4,
  ADJUST: 7,
} as const;

type Year = 'Last' | 'This' | 'Next';
const YEARS: Year[] = ['Last', 'This', 'Next'];
/** Field-name stems per year: the GL record and the Chart spell them differently. */
const GL_YEAR: Record<Year, string> = {
  Last: 'LstYr',
  This: 'ThsYr',
  Next: 'NxtYr',
};
const CHART_YEAR: Record<Year, string> = {
  Last: 'LastYr',
  This: 'ThisYr',
  Next: 'NextYr',
};

export interface PeachtreeCheck {
  code: string;
  label: string;
  passed: boolean;
  expected: string;
  actual: string;
  details: Array<Record<string, unknown>>;
}

export interface PeachtreeFinding {
  code:
    | 'PEACHTREE_POSTED_AFTER_CUTOVER'
    | 'PEACHTREE_CONTROL_DIFFERENCE'
    | 'PEACHTREE_NET_CREDIT';
  /** Stable, for the owner's decision: `peachtree::<key>`. */
  key: string;
  severity: 'blocking' | 'warning';
  /** A blocking finding the owner may accept rather than fix. */
  acceptable: boolean;
  message: string;
}

export interface GridRow {
  rowNumber: number;
  cells: Array<string | null>;
}
export interface Grid {
  name: string;
  /** Row 1 holds the starter workbook's headers, so the sheet is detected as it. */
  rows: GridRow[];
}

/** Everything the analysis needs, small enough to store as JSON. */
export interface PeachtreeExtract {
  format: 'finmatrix-peachtree-extract';
  version: 1;
  source: {
    peachtreeVersion: string;
    company: string;
    firstEntryDate: string | null;
    lastEntryDate: string | null;
    fiscalYearStartMonth: number;
    cutoverDate: string;
    openingDate: string;
    records: Record<string, number>;
  };
  grids: Grid[];
  /** Stock quantities from the inventory ledger; values come from the report. */
  stock: {
    inventoryAccount: string;
    peachtreeAccount: string | null;
    ledgerBalance: string;
    items: Array<{
      sku: string;
      code?: string;
      name: string;
      quantity: string;
    }>;
  };
  /**
   * The figures in Peachtree's own terms — its account IDs, its customers'
   * and vendors' balances before any credit is applied, item quantities — for
   * the comparison with Peachtree's reports. Balances are debit-positive for
   * accounts; what a customer owes / what is owed to a vendor for parties.
   */
  peachtree: {
    accounts: Array<{
      id: string;
      name: string;
      balance: string;
      number: string | null;
    }>;
    customers: Array<{ id: string; name: string; balance: string }>;
    vendors: Array<{ id: string; name: string; balance: string }>;
    /** `sku` is Peachtree's item ID; `code` the SKU FinMatrix gives it. */
    items: Array<{
      sku: string;
      code?: string;
      name: string;
      quantity: string;
    }>;
  };
  checks: PeachtreeCheck[];
  findings: PeachtreeFinding[];
  warnings: string[];
}

export interface ReadOptions {
  cutoverDate: string;
  openingDate: string;
  /** Account numbers already in the company's chart: a number FinMatrix makes up avoids them. */
  existingAccounts: ReadonlyArray<{ accountNumber: string; name: string }>;
  /**
   * Where FinMatrix keeps customer credits (its Customer Advances account).
   * Peachtree's own accounts — its controls included — keep their IDs: the
   * analysis moves FinMatrix's accounts to them, not the other way round.
   */
  numbers: {
    customerAdvances: string;
  };
  onProgress?: (stage: string, done: number) => void;
}

interface Account {
  record: number;
  id: string;
  name: string;
  type: number;
  inactive: boolean;
  begBal: Decimal;
  nets: Record<Year, Decimal[]>;
  lastYearClose: Decimal;
  thisYearClose: Decimal;
}

interface Period {
  year: Year;
  n: number;
  from: string;
  to: string;
}

interface OpenDoc {
  party: number;
  number: string;
  date: string;
  due: string | null;
  original: Decimal;
  /** Amount owed by (customer) or to (vendor) the company; negative = a credit. */
  open: Decimal;
  postOrder: number;
  netted: string[];
}

const D = (v: FieldValue) => new Decimal(typeof v === 'number' ? v : 0);
// Sign tests here use greaterThan(0) / lessThan(0): decimal.js calls zero
// "positive", and a fully netted invoice must not stay open at Rs 0.
const money = (d: Decimal) => d.toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const fmt = (d: Decimal) => money(d).toFixed(2);

class Reader {
  constructor(private readonly dict: Map<string, TableDef>) {}
  table(name: string): TableDef {
    const t = this.dict.get(name.toLowerCase());
    if (!t) throw new Error(`The backup's dictionary has no ${name} table.`);
    return t;
  }
  field(table: TableDef, name: string) {
    const f = table.fields.get(name.toLowerCase());
    if (!f)
      throw new Error(`The backup's ${table.name} table has no ${name} field.`);
    return f;
  }
  getter(tableName: string) {
    const t = this.table(tableName);
    const cache = new Map<string, ReturnType<Reader['field']>>();
    return (rec: Buffer, name: string): FieldValue => {
      let f = cache.get(name);
      if (!f) {
        f = this.field(t, name);
        cache.set(name, f);
      }
      return decodeField(rec, f);
    };
  }
}

/** Read the company from the extracted tables (upper-cased name → path). */
export async function readPeachtreeBooks(
  paths: ReadonlyMap<string, string>,
  opts: ReadOptions,
): Promise<PeachtreeExtract> {
  const need = (name: string) => {
    const p = paths.get(name);
    if (!p)
      throw new Error(
        `The backup has no ${name}; it is not a complete Peachtree company.`,
      );
    return p;
  };
  const dict = await readDictionary(need('FILE.DDF'), need('FIELD.DDF'));
  const r = new Reader(dict);
  const records: Record<string, number> = {};
  const warnings: string[] = [];
  const checks: PeachtreeCheck[] = [];
  const findings: PeachtreeFinding[] = [];

  const each = async (
    file: string,
    table: string | null,
    fn: (rec: Buffer) => void,
  ) => {
    const bt = await BtrieveFile.open(need(file), file);
    let n = 0;
    try {
      const len = table ? r.table(table).recordLength : undefined;
      for await (const rec of bt.records(len)) {
        fn(rec);
        if (++n % 50_000 === 0) opts.onProgress?.(file, n);
      }
    } finally {
      await bt.close();
    }
    records[file] = n;
    opts.onProgress?.(file, n);
  };

  const peachtreeVersion = (
    await readFile(need('VERSION.TXT'), 'latin1')
  ).trim();

  let company = '';
  {
    const g = r.getter('Company');
    await each('COMPANY.DAT', 'Company', (rec) => {
      company ||= String(g(rec, 'CompanyName') ?? '');
    });
  }

  // ── Fiscal periods and control accounts (General.DAT) ──────────────
  const periods: Period[] = [];
  let arControl = 0;
  let apControl = 0;
  {
    const g = r.getter('General_GL');
    let found = false;
    await each('GENERAL.DAT', null, (rec) => {
      const module = rec.readUInt16LE(0);
      if (module === 1) arControl = rec.readUInt32LE(2);
      if (module === 2) apControl = rec.readUInt32LE(2);
      if (module !== 4) return;
      found = true;
      for (const year of YEARS) {
        let prevTo = '';
        for (let n = 1; n <= 13; n++) {
          let from: string | null = null;
          let to: string | null = null;
          try {
            from = g(rec, `${GL_YEAR[year]}Per${n}FrmDate`) as string | null;
            to = g(rec, `${GL_YEAR[year]}Per${n}ToDate`) as string | null;
          } catch {
            continue;
          }
          // An unused 13th period keeps a placeholder far in the past.
          if (!from || !to || from > to || (prevTo && from <= prevTo)) continue;
          periods.push({ year, n, from, to });
          prevTo = to;
        }
      }
    });
    if (!found || periods.length === 0) {
      throw new Error(
        'The backup has no fiscal periods (General ledger settings are missing).',
      );
    }
    periods.sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 1; i < periods.length; i++) {
      if (periods[i].from <= periods[i - 1].to) {
        throw new Error("The backup's fiscal periods overlap.");
      }
    }
  }
  const fiscalYearStartMonth = Number(
    periods.find((p) => p.year === 'Last' && p.n === 1)?.from.slice(5, 7) ??
      periods[0].from.slice(5, 7),
  );
  const periodOf = (date: string) =>
    periods.find((p) => date >= p.from && date <= p.to) ?? null;
  const openingPeriod = periodOf(opts.openingDate);
  const lastPeriodEnd = periods[periods.length - 1].to;
  const currentYear: Year | null = openingPeriod
    ? openingPeriod.year
    : opts.openingDate > lastPeriodEnd
      ? null
      : 'Last';
  const yearRank = (y: Year) => YEARS.indexOf(y);

  // ── Chart ─────────────────────────────────────────────────────────
  const accounts = new Map<number, Account>();
  {
    const g = r.getter('Chart');
    await each('CHART.DAT', 'Chart', (rec) => {
      const nets = {} as Record<Year, Decimal[]>;
      for (const y of YEARS) {
        nets[y] = [];
        for (let n = 1; n <= 13; n++)
          nets[y].push(D(g(rec, `${CHART_YEAR[y]}Per${n}Net`)));
      }
      const record = Number(g(rec, 'GLAcntNumber'));
      accounts.set(record, {
        record,
        id: String(g(rec, 'AccountID') ?? '').trim(),
        name: String(g(rec, 'AccountDescription') ?? '').trim(),
        type: Number(g(rec, 'AccountType')),
        inactive: Boolean(g(rec, 'AccountIsInactive')),
        begBal: D(g(rec, 'BegBal_Net')),
        nets,
        lastYearClose: D(g(rec, 'LstYrCloseNet')),
        thisYearClose: D(g(rec, 'ThisYrCloseNet')),
      });
    });
  }
  const retained = [...accounts.values()].filter(
    (a) => a.type === PT.EQUITY_RETAINED,
  );
  if (retained.length !== 1) {
    throw new Error(
      `The backup has ${retained.length} retained-earnings accounts; Peachtree keeps exactly one.`,
    );
  }
  const reAccount = retained[0];
  const unknownTypes = [...accounts.values()].filter(
    (a) => !Object.values(PT).includes(a.type as never),
  );
  if (unknownTypes.length) {
    throw new Error(
      `Accounts of an account type this reader does not know: ${unknownTypes
        .slice(0, 5)
        .map((a) => `${a.id} (type ${a.type})`)
        .join(', ')}.`,
    );
  }

  // ── Customers, vendors, items ──────────────────────────────────────
  type Party = {
    record: number;
    /** FinMatrix's code for the Peachtree ID (see assignCodes). */
    code: string;
    id: string;
    name: string;
    phone: string;
    email: string;
    address: string;
    city: string;
    dueDays: number;
    cod: boolean;
    creditLimit: Decimal;
    taxId: string;
    inactive: boolean;
    balance: Decimal;
  };
  const customers = new Map<number, Party>();
  {
    const g = r.getter('Customers');
    await each('CUSTOMER.DAT', 'Customers', (rec) => {
      const id = String(g(rec, 'CustomerID') ?? '').trim();
      customers.set(Number(g(rec, 'CustomerRecordNumber')), {
        record: Number(g(rec, 'CustomerRecordNumber')),
        code: id,
        id,
        name: String(g(rec, 'Customer_Bill_Name') ?? '').trim() || id,
        phone: String(g(rec, 'Phone_Number') ?? '').trim(),
        email: String(g(rec, 'eMail_Address') ?? '').trim(),
        address: [g(rec, 'Bill_Addr1'), g(rec, 'Bill_Address2')]
          .map((x) => String(x ?? '').trim())
          .filter(Boolean)
          .join(', '),
        city: String(g(rec, 'Bill_City') ?? '').trim(),
        dueDays: Number(g(rec, 'Terms_DueDays') ?? 0),
        cod: Boolean(g(rec, 'Terms_COD')),
        creditLimit: D(g(rec, 'Terms_CreditLimit')),
        taxId: String(g(rec, 'SalesTaxResaleNum') ?? '').trim(),
        inactive: Boolean(g(rec, 'CustomerIsInactive')),
        balance: D(g(rec, 'Balance')),
      });
    });
  }
  const vendors = new Map<number, Party>();
  {
    const g = r.getter('Vendors');
    await each('VENDOR.DAT', 'Vendors', (rec) => {
      const id = String(g(rec, 'VendorID') ?? '').trim();
      vendors.set(Number(g(rec, 'VendorRecordNumber')), {
        record: Number(g(rec, 'VendorRecordNumber')),
        code: id,
        id,
        name: String(g(rec, 'VendorName') ?? '').trim() || id,
        phone: String(g(rec, 'PhoneNumber') ?? '').trim(),
        email: String(g(rec, 'Email') ?? '').trim(),
        address: [g(rec, 'Address1'), g(rec, 'Address2')]
          .map((x) => String(x ?? '').trim())
          .filter(Boolean)
          .join(', '),
        city: String(g(rec, 'City') ?? '').trim(),
        dueDays: Number(g(rec, 'DueDays') ?? 0),
        cod: Boolean(g(rec, 'TermsCOD')),
        creditLimit: new Decimal(0),
        taxId: String(g(rec, 'FederalEIN') ?? '').trim(),
        inactive: Boolean(g(rec, 'VendorIsInactive')),
        balance: D(g(rec, 'Balance')),
      });
    });
  }
  type Item = {
    record: number;
    sku: string;
    /** FinMatrix's SKU for the Peachtree item ID (see assignCodes). */
    code: string;
    name: string;
    category: string;
    unit: string;
    price: Decimal;
    reorder: Decimal;
    inactive: boolean;
    inventoryAccount: number;
    cogsAccount: number;
  };
  const items = new Map<number, Item>();
  {
    const g = r.getter('LineItem');
    await each('LINEITEM.DAT', 'LineItem', (rec) => {
      const sku = String(g(rec, 'ItemID') ?? '').trim();
      items.set(Number(g(rec, 'ItemRecordNumber')), {
        record: Number(g(rec, 'ItemRecordNumber')),
        sku,
        code: sku,
        name: String(g(rec, 'ItemDescription') ?? '').trim() || sku,
        category: String(g(rec, 'Category') ?? '').trim(),
        unit: String(g(rec, 'StockingUM') ?? '').trim(),
        price: D(g(rec, 'PriceLevel1Amount')),
        reorder: D(g(rec, 'ReorderPoint')),
        inactive: Boolean(g(rec, 'ItemIsInactive')),
        inventoryAccount: Number(g(rec, 'InvAcctRecordNumber') ?? 0),
        cogsAccount: Number(g(rec, 'COGSAcctRecordNumber') ?? 0),
      });
    });
  }
  /** Accounts the costing engine posts to: their journal rows carry 0 for cost. */
  const costing = new Set<number>();
  for (const it of items.values()) {
    if (it.inventoryAccount) costing.add(it.inventoryAccount);
    if (it.cogsAccount) costing.add(it.cogsAccount);
  }
  const inventoryAccounts = [...accounts.values()].filter(
    (a) => a.type === PT.INVENTORY,
  );
  const inventoryControl =
    inventoryAccounts.length === 1
      ? inventoryAccounts[0]
      : (() => {
          const use = new Map<number, number>();
          for (const it of items.values())
            use.set(
              it.inventoryAccount,
              (use.get(it.inventoryAccount) ?? 0) + 1,
            );
          const top = [...use].sort((a, b) => b[1] - a[1])[0]?.[0];
          return top ? (accounts.get(top) ?? null) : null;
        })();

  // ── Transactions ──────────────────────────────────────────────────
  const invoices: OpenDoc[] = [];
  const bills: OpenDoc[] = [];
  let unposted = 0;
  {
    const g = r.getter('JrnlHdr');
    await each('JRNLHDR.DAT', 'JrnlHdr', (rec) => {
      const journal = Number(g(rec, 'JrnlKey_Journal'));
      const module = String(g(rec, 'Module') ?? '');
      const posting =
        journal <= JOURNAL.PURCHASES || journal === JOURNAL.ADJUST;
      if (posting && module && !g(rec, 'TrxIsPosted')) unposted++;
      const isSale = journal === JOURNAL.SALES && module === 'R';
      const isBill = journal === JOURNAL.PURCHASES && module === 'P';
      if (!isSale && !isBill) return;
      // Rounded at once: the floats carry noise far below a paisa, and a
      // credit must never be applied as 0.0000001 of an invoice.
      const main = money(D(g(rec, 'MainAmount')));
      const out = money(main.minus(money(D(g(rec, 'AmountPaid')))));
      if (out.isZero()) return;
      const postOrder = Number(g(rec, 'PostOrder'));
      const doc: OpenDoc = {
        party: Number(g(rec, 'CustVendId')),
        number: String(g(rec, 'Reference') ?? '').trim() || `PT-${postOrder}`,
        date: String(g(rec, 'TransactionDate')),
        due: (g(rec, 'DateDue') as string | null) ?? null,
        original: isSale ? main : main.negated(),
        open: isSale ? out : out.negated(),
        postOrder,
        netted: [],
      };
      (isSale ? invoices : bills).push(doc);
    });
  }

  const rowNets = new Map<number, Map<string, Decimal>>();
  const journalTotals = new Map<number, Decimal>();
  const quantities = new Map<number, Decimal>();
  const unknownQuantity = new Map<string, number>();
  let firstEntry: string | null = null;
  let lastEntry: string | null = null;
  const after = { rows: 0, first: '', last: '', orders: new Set<number>() };
  {
    const g = r.getter('JrnlRow');
    await each('JRNLROW.DAT', 'JrnlRow', (rec) => {
      const date = g(rec, 'RowDate') as string | null;
      const journal = Number(g(rec, 'Journal'));
      const inGl = Number(g(rec, 'IncludeInGL')) !== 0;
      if (inGl && date) {
        const amount = D(g(rec, 'Amount'));
        const account = Number(g(rec, 'GLAcntNumber'));
        journalTotals.set(
          journal,
          (journalTotals.get(journal) ?? new Decimal(0)).plus(amount),
        );
        const p = periodOf(date);
        const key = p
          ? `${p.year}${p.n}`
          : date < periods[0].from
            ? 'before'
            : 'after';
        const m = rowNets.get(account) ?? new Map<string, Decimal>();
        m.set(key, (m.get(key) ?? new Decimal(0)).plus(amount));
        rowNets.set(account, m);
        if (!firstEntry || date < firstEntry) firstEntry = date;
        if (!lastEntry || date > lastEntry) lastEntry = date;
        if (date >= opts.cutoverDate) {
          after.rows++;
          after.orders.add(Number(g(rec, 'PostOrder')));
          if (!after.first || date < after.first) after.first = date;
          if (date > after.last) after.last = date;
        }
      }
      const item = Number(g(rec, 'ItemRecordNumber'));
      if (item && Number(g(rec, 'IncludeInInvLedger')) !== 0) {
        const q = D(g(rec, 'StockingQuantity'));
        if (q.isZero()) return;
        // Purchases add, sales (and cash sales on a receipt) take away, an
        // adjustment carries its own sign.
        const signed =
          journal === JOURNAL.PURCHASES || journal === JOURNAL.ADJUST
            ? q
            : journal === JOURNAL.SALES || journal === JOURNAL.RECEIPTS
              ? q.negated()
              : null;
        if (!signed) {
          const k = `journal ${journal}`;
          unknownQuantity.set(k, (unknownQuantity.get(k) ?? 0) + 1);
          return;
        }
        quantities.set(
          item,
          (quantities.get(item) ?? new Decimal(0)).plus(signed),
        );
      }
    });
  }

  // ── Cross-checks inside the backup ────────────────────────────────
  {
    const off = [...journalTotals].filter(([, t]) => !money(t).isZero());
    checks.push({
      code: 'PT_JOURNALS_BALANCE',
      label: 'Every Peachtree journal balances',
      passed: off.length === 0,
      expected: '0.00',
      actual: off.length
        ? off.map(([j, t]) => `journal ${j}: ${fmt(t)}`).join('; ')
        : '0.00',
      details: off.map(([journal, total]) => ({ journal, total: fmt(total) })),
    });
  }
  {
    let equal = 0;
    const differ: Array<Record<string, unknown>> = [];
    for (const a of accounts.values()) {
      if (costing.has(a.record)) continue;
      const m = rowNets.get(a.record);
      for (const p of periods) {
        const stored = money(a.nets[p.year][p.n - 1]);
        const rows = money(m?.get(`${p.year}${p.n}`) ?? new Decimal(0));
        if (stored.equals(rows)) equal++;
        else if (differ.length < 50)
          differ.push({
            account: a.id,
            period: `${p.year} year, period ${p.n}`,
            stored: stored.toFixed(2),
            journal: rows.toFixed(2),
          });
        else differ.push({});
      }
    }
    checks.push({
      code: 'PT_PERIODS_REBUILD',
      label: "Each account's period totals rebuild from its transactions",
      passed: differ.length === 0,
      expected: `${equal + differ.length} account-periods`,
      actual: `${equal} equal`,
      details: [
        ...differ.filter((d) => Object.keys(d).length),
        {
          note: `Inventory and cost-of-sales accounts (${[...costing]
            .map((x) => accounts.get(x)?.id)
            .filter(Boolean)
            .join(
              ', ',
            )}) are left out: Peachtree's costing engine posts their cost amounts, which the transaction rows carry as 0. Peachtree's own trial balance and inventory valuation prove them.`,
        },
      ],
    });
  }
  {
    const pnl = (y: Year) =>
      [...accounts.values()]
        .filter((a) => CLOSES.has(a.type))
        .reduce(
          (t, a) =>
            t.plus(a.nets[y].reduce((s, x) => s.plus(x), new Decimal(0))),
          new Decimal(0),
        );
    const rows: Array<Record<string, unknown>> = [];
    let ok = true;
    const cmp = (y: Year, stored: Decimal) => {
      const computed = pnl(y);
      const same = money(stored).equals(money(computed));
      ok &&= same;
      rows.push({
        year: `${y} year`,
        storedYearClose: fmt(stored),
        profitAndLoss: fmt(computed),
        ok: same,
      });
    };
    if (currentYear === null || yearRank(currentYear) > yearRank('Last'))
      cmp('Last', reAccount.lastYearClose);
    if (currentYear === null || yearRank(currentYear) > yearRank('This'))
      cmp('This', reAccount.thisYearClose);
    checks.push({
      code: 'PT_YEAR_CLOSE',
      label:
        "Retained earnings' year-close figures equal each closed year's profit",
      passed: ok,
      expected: 'equal',
      actual: ok ? 'equal' : 'different',
      details: rows,
    });
  }

  // ── Opening trial balance (Peachtree's ledger at the opening date) ──
  const closing = new Map<number, Decimal>();
  {
    const sum = (a: Account, keep: (y: Year) => boolean) =>
      YEARS.filter(keep).reduce(
        (t, y) => t.plus(a.nets[y].reduce((s, x) => s.plus(x), new Decimal(0))),
        new Decimal(0),
      );
    let earlier = new Decimal(0);
    for (const a of accounts.values()) {
      if (CLOSES.has(a.type)) {
        const current = currentYear
          ? sum(a, (y) => y === currentYear)
          : new Decimal(0);
        closing.set(a.record, current);
        earlier = earlier
          .plus(a.begBal)
          .plus(
            sum(a, (y) =>
              currentYear ? yearRank(y) < yearRank(currentYear) : true,
            ),
          );
      } else {
        closing.set(a.record, a.begBal.plus(sum(a, () => true)));
      }
    }
    closing.set(reAccount.record, closing.get(reAccount.record)!.plus(earlier));
    const total = [...closing.values()].reduce(
      (t, x) => t.plus(x),
      new Decimal(0),
    );
    checks.push({
      code: 'PT_TB_BALANCES',
      label: "Peachtree's trial balance balances",
      passed: money(total).isZero(),
      expected: '0.00',
      actual: fmt(total),
      details: [],
    });
  }

  if (after.rows > 0) {
    findings.push({
      code: 'PEACHTREE_POSTED_AFTER_CUTOVER',
      key: 'posted-after-cutover',
      severity: 'blocking',
      acceptable: false,
      message: `The backup has ${after.orders.size} transaction${after.orders.size === 1 ? '' : 's'} dated on or after the cutover date ${opts.cutoverDate} (${after.first} to ${after.last}). The opening balances are those at the close of ${opts.openingDate}: start a migration with a cutover date after ${lastEntry}, or use a backup taken before those entries.`,
    });
  }
  if (unposted > 0) {
    warnings.push(
      `${unposted} Peachtree transaction${unposted === 1 ? ' is' : 's are'} not posted; unposted transactions are not part of Peachtree's ledger and are not brought in.`,
    );
  }
  for (const [k, n] of unknownQuantity)
    warnings.push(
      `${n} inventory movement${n === 1 ? '' : 's'} on ${k} had no known direction and were left out of the stock quantities.`,
    );

  // ── Party balances against their documents ─────────────────────────
  const partyCheck = (
    code: string,
    label: string,
    parties: Map<number, Party>,
    docs: OpenDoc[],
  ) => {
    const byParty = new Map<number, Decimal>();
    for (const d of docs)
      byParty.set(
        d.party,
        (byParty.get(d.party) ?? new Decimal(0)).plus(d.open),
      );
    const differ: Array<Record<string, unknown>> = [];
    for (const p of parties.values()) {
      const docsTotal = money(byParty.get(p.record) ?? new Decimal(0));
      const stored = money(code === 'PT_VENDORS_MATCH' ? p.balance : p.balance);
      if (!stored.equals(docsTotal))
        differ.push({
          party: p.id,
          storedBalance: stored.toFixed(2),
          openDocuments: docsTotal.toFixed(2),
        });
    }
    const orphans = docs.filter((d) => !parties.has(d.party));
    for (const o of orphans.slice(0, 20))
      differ.push({
        document: o.number,
        note: 'its customer or vendor is not in the backup',
      });
    checks.push({
      code,
      label,
      passed: differ.length === 0,
      expected: `${parties.size} balances`,
      actual: `${parties.size - differ.length} equal`,
      details: differ.slice(0, 50),
    });
  };
  partyCheck(
    'PT_CUSTOMERS_MATCH',
    "Each customer's balance equals its open invoices",
    customers,
    invoices,
  );
  partyCheck(
    'PT_VENDORS_MATCH',
    "Each vendor's balance equals its open bills",
    vendors,
    bills,
  );

  // ── Credits: applied to the same party's open documents, oldest first ──
  const net = (docs: OpenDoc[]) => {
    const residual = new Map<number, Decimal>();
    const byParty = new Map<number, OpenDoc[]>();
    for (const d of docs) {
      const l = byParty.get(d.party) ?? [];
      l.push(d);
      byParty.set(d.party, l);
    }
    for (const [party, list] of byParty) {
      const credits = list
        .filter((d) => d.open.lessThan(0))
        .sort(
          (a, b) => a.date.localeCompare(b.date) || a.postOrder - b.postOrder,
        );
      const debts = list
        .filter((d) => d.open.greaterThan(0))
        .sort(
          (a, b) =>
            (a.due ?? a.date).localeCompare(b.due ?? b.date) ||
            a.date.localeCompare(b.date) ||
            a.postOrder - b.postOrder,
        );
      for (const c of credits) {
        let left = c.open.negated();
        for (const d of debts) {
          if (left.isZero()) break;
          if (!d.open.greaterThan(0)) continue;
          const take = Decimal.min(left, d.open);
          d.open = d.open.minus(take);
          left = left.minus(take);
          d.netted.push(`${c.number} (${fmt(take)})`);
        }
        c.open = left.negated();
        if (!left.isZero())
          residual.set(
            party,
            (residual.get(party) ?? new Decimal(0)).plus(left),
          );
      }
    }
    return { open: docs.filter((d) => money(d.open).greaterThan(0)), residual };
  };
  const ar = net(invoices);
  const ap = net(bills);

  // ── Account numbers ────────────────────────────────────────────────
  // Every Peachtree account keeps its ID and name: the owner's chart is kept
  // exactly, and FinMatrix's own accounts take Peachtree's numbers (see
  // mapping/chart-plan). Only an ID FinMatrix cannot hold (too short or too
  // long) gets a number made up here, avoiding every number in use.
  const peachtreeIds = new Set(
    [...accounts.values()].map((a) => a.id.toUpperCase()),
  );
  const taken = new Set([
    ...opts.existingAccounts.map((a) => a.accountNumber.toUpperCase()),
    ...peachtreeIds,
  ]);
  const nextNumber: Record<string, number> = {
    asset: 18001,
    liability: 28001,
    equity: 38001,
    revenue: 48001,
    expense: 68001,
  };
  const fresh = (type: string) => {
    for (;;) {
      const n = String(nextNumber[type]++);
      if (!taken.has(n)) {
        taken.add(n);
        return n;
      }
    }
  };
  const meaning = (a: Account): { type: string; kind: string } => {
    const lower = a.name.toLowerCase();
    switch (a.type) {
      case PT.CASH:
        return { type: 'asset', kind: /bank/.test(lower) ? 'Bank' : 'Cash' };
      case PT.RECEIVABLE:
      case PT.OTHER_CURRENT_ASSET:
      case PT.OTHER_ASSET:
        return {
          type: 'asset',
          kind: /prepaid/.test(lower) ? 'Prepaid' : 'Other Asset',
        };
      case PT.INVENTORY:
        return { type: 'asset', kind: 'Other Asset' };
      case PT.FIXED_ASSET:
      case PT.ACCUMULATED_DEPRECIATION:
        return { type: 'asset', kind: 'Fixed Asset' };
      case PT.PAYABLE:
        return { type: 'liability', kind: 'Other Liability' };
      case PT.OTHER_CURRENT_LIABILITY:
        return {
          type: 'liability',
          kind: /tax/.test(lower) ? 'Tax Payable' : 'Other Liability',
        };
      case PT.LONG_TERM_LIABILITY:
        return { type: 'liability', kind: 'Notes Payable' };
      case PT.EQUITY_NO_CLOSE:
        return { type: 'equity', kind: 'Owner Equity' };
      case PT.EQUITY_RETAINED:
        return { type: 'equity', kind: 'Retained Earnings' };
      case PT.EQUITY_CLOSES:
        return { type: 'equity', kind: 'Owner Draws' };
      case PT.INCOME:
        return {
          type: 'revenue',
          kind: /other|interest/.test(lower) ? 'Other Revenue' : 'Sales',
        };
      case PT.COST_OF_SALES:
        return { type: 'expense', kind: 'Cost of Goods' };
      default:
        return {
          type: 'expense',
          kind: /depreciation/.test(lower)
            ? 'Depreciation'
            : /tax/.test(lower)
              ? 'Tax'
              : 'Operating',
        };
    }
  };
  const numberOf = new Map<number, string>();
  const accountRows: Array<Array<string | null>> = [];
  // Peachtree's control accounts are named by their kind, so FinMatrix's
  // Receivables, Payables, Inventory and Retained Earnings take them over.
  const controlKind = (a: Account): string | null =>
    a.record === arControl
      ? 'Accounts Receivable'
      : a.record === apControl
        ? 'Accounts Payable'
        : inventoryControl && a.record === inventoryControl.record
          ? 'Inventory'
          : a.record === reAccount.record
            ? 'Retained Earnings'
            : null;
  const used = new Set<string>();
  for (const a of [...accounts.values()].sort((x, y) =>
    x.id.localeCompare(y.id),
  )) {
    const control = controlKind(a);
    const bal = money(closing.get(a.record) ?? new Decimal(0));
    if (!control && a.inactive && bal.isZero()) continue;
    const m = meaning(a);
    const own = a.id.toUpperCase();
    const keep = a.id.length >= 2 && a.id.length <= 20 && !used.has(own);
    const number = keep ? a.id : fresh(m.type);
    used.add(number.toUpperCase());
    const name = keep
      ? a.name || a.id
      : `${a.name || a.id} (Peachtree ${a.id})`;
    numberOf.set(a.record, number);
    accountRows.push([
      number,
      name.slice(0, 150),
      cap(m.type),
      control ?? m.kind,
      null,
    ]);
  }

  // ── Trial balance lines ────────────────────────────────────────────
  const tbRows: Array<Array<string | null>> = [];
  const tbLine = (number: string, name: string, amount: Decimal) => {
    const v = money(amount);
    if (v.isZero()) return;
    tbRows.push([
      number,
      name,
      v.greaterThan(0) ? v.toFixed(2) : null,
      v.lessThan(0) ? v.negated().toFixed(2) : null,
    ]);
  };
  const newAccount = (type: string, kind: string, name: string) => {
    const number = fresh(type);
    accountRows.push([number, name.slice(0, 150), cap(type), kind, null]);
    return number;
  };
  let advancesNumber: string | undefined;
  const sumOpen = (docs: OpenDoc[]) =>
    docs.reduce((t, d) => t.plus(d.open), new Decimal(0));
  for (const a of [...accounts.values()].sort((x, y) =>
    x.id.localeCompare(y.id),
  )) {
    const bal = closing.get(a.record) ?? new Decimal(0);
    const number = numberOf.get(a.record);
    if (!number) {
      if (!money(bal).isZero())
        throw new Error(
          `Account ${a.id} has a balance but no FinMatrix number.`,
        );
      continue;
    }
    if (a.record === arControl) {
      const detail = sumOpen(ar.open);
      const credits = [...ar.residual.values()].reduce(
        (t, x) => t.plus(x),
        new Decimal(0),
      );
      tbLine(number, a.name || 'Accounts Receivable', detail);
      if (!credits.isZero()) {
        // FinMatrix's Customer Advances account, at its own number unless a
        // Peachtree account already holds that number.
        const def = SYSTEM_ACCOUNT_DEFS.customer_advances;
        advancesNumber ??= used.has(opts.numbers.customerAdvances.toUpperCase())
          ? fresh('liability')
          : opts.numbers.customerAdvances;
        accountRows.push([
          advancesNumber,
          def.name,
          cap(def.type),
          def.subType,
          null,
        ]);
        tbLine(
          advancesNumber,
          'Customer credits (from Peachtree)',
          credits.negated(),
        );
        const who = [...ar.residual]
          .map(([p, x]) => `${customers.get(p)?.id ?? p} ${fmt(x)}`)
          .join(', ');
        findings.push({
          code: 'PEACHTREE_NET_CREDIT',
          key: 'customer-credits',
          severity: 'blocking',
          acceptable: true,
          message: `In Peachtree ${ar.residual.size} customer${ar.residual.size === 1 ? ' is' : 's are'} owed money by you (${who}). FinMatrix will hold the Rs ${fmt(credits)} on ${advancesNumber} Customer Advances, not on the customer, so apply it by hand when they next buy. Accept, or settle the credits in Peachtree and upload a new backup.`,
        });
      }
      const diff = bal.minus(detail).plus(credits);
      if (!money(diff).isZero()) {
        const n = newAccount(
          'asset',
          'Other Asset',
          `Receivables not on any invoice (from Peachtree ${a.id})`,
        );
        tbLine(
          n,
          `Receivables not on any invoice (from Peachtree ${a.id})`,
          diff,
        );
        findings.push({
          code: 'PEACHTREE_CONTROL_DIFFERENCE',
          key: 'receivables-difference',
          severity: 'blocking',
          acceptable: true,
          message: `Peachtree's receivables account ${a.id} holds Rs ${fmt(bal)}, its customers Rs ${fmt(bal.minus(diff))}: the account is Rs ${fmt(diff.abs())} ${diff.greaterThan(0) ? 'higher' : 'lower'} than its customers, from entries posted straight to it. The difference will be kept on its own account, ${n} "Receivables not on any invoice", for you to clear. Accept, or correct it in Peachtree and upload a new backup.`,
        });
      }
      continue;
    }
    if (a.record === apControl) {
      const detail = sumOpen(ap.open);
      const advances = [...ap.residual.values()].reduce(
        (t, x) => t.plus(x),
        new Decimal(0),
      );
      tbLine(number, a.name || 'Accounts Payable', detail.negated());
      if (!advances.isZero()) {
        const n = newAccount(
          'asset',
          'Other Asset',
          'Advances to vendors (from Peachtree)',
        );
        tbLine(n, 'Advances to vendors (from Peachtree)', advances);
        findings.push({
          code: 'PEACHTREE_NET_CREDIT',
          key: 'vendor-advances',
          severity: 'blocking',
          acceptable: true,
          message: `In Peachtree you are owed Rs ${fmt(advances)} by ${ap.residual.size} vendor${ap.residual.size === 1 ? '' : 's'} (credits larger than their bills). It will be held on ${n} "Advances to vendors", not on the vendor. Accept, or settle them in Peachtree and upload a new backup.`,
        });
      }
      // AP is a credit: the ledger balance is negative, the detail positive.
      const diff = bal.plus(detail).minus(advances);
      if (!money(diff).isZero()) {
        const n = newAccount(
          'liability',
          'Other Liability',
          `Payables not on any bill (from Peachtree ${a.id})`,
        );
        tbLine(n, `Payables not on any bill (from Peachtree ${a.id})`, diff);
        findings.push({
          code: 'PEACHTREE_CONTROL_DIFFERENCE',
          key: 'payables-difference',
          severity: 'blocking',
          acceptable: true,
          message: `Peachtree's payables account ${a.id} holds Rs ${fmt(bal.negated())}, its vendors Rs ${fmt(detail.minus(advances))}: the account is Rs ${fmt(diff.abs())} ${diff.lessThan(0) ? 'higher' : 'lower'} than its vendors, from entries posted straight to it. The difference will be kept on its own account, ${n} "Payables not on any bill", for you to clear. Accept, or correct it in Peachtree and upload a new backup.`,
        });
      }
      continue;
    }
    tbLine(number, a.name || a.id, bal);
  }

  // ── Grids, as the starter workbook would hold them ──────────────────
  const terms = (p: Party) =>
    p.cod || p.dueDays === 0
      ? 'Due on receipt'
      : [15, 30, 45, 60].includes(p.dueDays)
        ? `Net ${p.dueDays}`
        : null;
  const party = (p: Party, kind: 'customer' | 'vendor') => {
    const base = [
      p.code || null,
      p.name,
      p.phone || null,
      p.email || null,
      p.address || null,
      p.city || null,
      terms(p),
    ];
    return kind === 'customer'
      ? [
          ...base,
          p.creditLimit.isZero() ? null : fmt(p.creditLimit),
          p.taxId || null,
        ]
      : [...base, p.taxId || null];
  };
  const keepParty = (p: Party, docs: OpenDoc[]) =>
    !p.inactive ||
    !money(p.balance).isZero() ||
    docs.some((d) => d.party === p.record);
  // Document numbers FinMatrix keeps apart: it compares them ignoring case,
  // spaces and punctuation (normalizeKey), so "0407.2026" and "04072026"
  // are one number to it. Each of a repeated number carries its party's
  // code, and -2, -3… if that is still not enough.
  const renumbered: string[] = [];
  const unique = (
    docs: OpenDoc[],
    parties: Map<number, Party>,
    max: number,
  ) => {
    const count = new Map<string, number>();
    for (const d of docs) {
      const k = normalizeKey(d.number.slice(0, max));
      count.set(k, (count.get(k) ?? 0) + 1);
    }
    const used = new Set<string>();
    for (const [k, c] of count) if (k && c === 1) used.add(k);
    return docs.map((d) => {
      const p = parties.get(d.party);
      const code = p?.code ?? String(d.party);
      let number = d.number.slice(0, max);
      const k = normalizeKey(number);
      if (!k || count.get(k)! > 1) {
        const base = `${d.number}/${code}`;
        number = base.slice(0, max);
        for (
          let n = 2;
          !normalizeKey(number) || used.has(normalizeKey(number));
          n++
        ) {
          const suffix = `-${n}`;
          number = base.slice(0, max - suffix.length) + suffix;
        }
        used.add(normalizeKey(number));
        renumbered.push(`${d.number} → ${number}`);
      }
      return [
        code,
        number,
        d.date,
        d.due && d.due >= d.date ? d.due : null,
        fmt(d.original),
        fmt(d.open),
      ];
    });
  };
  const stockItems = [...items.values()]
    .map((it) => ({ it, q: quantities.get(it.record) ?? new Decimal(0) }))
    .filter(({ q }) => !q.isZero());
  const keptCustomers = [...customers.values()].filter((p) =>
    keepParty(p, invoices),
  );
  const keptVendors = [...vendors.values()].filter((p) => keepParty(p, bills));
  const keptItems = [...items.values()].filter(
    (it) => !it.inactive || quantities.has(it.record),
  );
  // Peachtree compares its IDs exactly. FinMatrix ignores case, spaces and
  // punctuation when it compares codes and names, keeps customer and vendor
  // IDs upper-case (letters, digits and . _ / -, up to 20), and reads a
  // repeated name as the same party. So every ID takes its FinMatrix form,
  // with -2, -3… where two would otherwise become one, and each of a
  // repeated name carries its code. The owner is told of every change.
  const recoded = [
    ...assignCodes(
      keptCustomers,
      (p) => p.id,
      partyCodeForm,
      20,
      (p, c) => (p.code = c),
    ),
    ...assignCodes(
      keptVendors,
      (p) => p.id,
      partyCodeForm,
      20,
      (p, c) => (p.code = c),
    ),
    ...assignCodes(
      keptItems,
      (it) => it.sku,
      (id) => id.trim(),
      64,
      (it, c) => (it.code = c),
    ),
  ];
  if (recoded.length)
    warnings.push(
      `${recoded.length} Peachtree ID${recoded.length === 1 ? '' : 's'} cannot be kept exactly as FinMatrix ID${recoded.length === 1 ? '' : 's'} (FinMatrix IDs use letters, numbers and . _ / -, and ignore capitals), so ${recoded.length === 1 ? 'it becomes' : 'they become'}: ${recoded
        .slice(0, 20)
        .map((c) => `${c.id} → ${c.code}`)
        .join('; ')}${recoded.length > 20 ? '; …' : ''}.`,
    );
  const renamed = [
    ...distinctNames(
      keptCustomers,
      (p) => p.code,
      (p, n) => (p.name = n),
    ),
    ...distinctNames(
      keptVendors,
      (p) => p.code,
      (p, n) => (p.name = n),
    ),
    ...distinctNames(
      keptItems,
      (it) => it.code,
      (it, n) => (it.name = n),
    ),
  ];
  if (renamed.length)
    warnings.push(
      `${renamed.length} customers, vendors or items share a name with another in Peachtree; each now carries its ID to tell them apart: ${renamed.slice(0, 20).join('; ')}${renamed.length > 20 ? '; …' : ''}.`,
    );
  const grids: Grid[] = [
    grid('Accounts (Peachtree)', 'accounts', accountRows),
    grid(
      'Customers (Peachtree)',
      'customers',
      keptCustomers.map((p) => party(p, 'customer')),
    ),
    grid(
      'Vendors (Peachtree)',
      'vendors',
      keptVendors.map((p) => party(p, 'vendor')),
    ),
  ];
  const itemRows = keptItems.map((it) => [
    it.code,
    it.name,
    it.category || null,
    it.unit || null,
    '0',
    fmt(it.price),
    it.reorder.isZero() ? null : it.reorder.toString(),
  ]);
  if (itemRows.length) grids.push(grid('Items (Peachtree)', 'items', itemRows));
  grids.push(grid('Trial Balance (Peachtree)', 'trial_balance', tbRows));
  if (ar.open.length)
    grids.push(
      grid(
        'Open Invoices (Peachtree)',
        'open_invoices',
        unique(ar.open, customers, 32),
      ),
    );
  if (ap.open.length)
    grids.push(
      grid(
        'Open Bills (Peachtree)',
        'open_bills',
        unique(ap.open, vendors, 64),
      ),
    );
  if (renumbered.length)
    warnings.push(
      `${renumbered.length} open invoice${renumbered.length === 1 ? '' : 's'} or bill${renumbered.length === 1 ? '' : 's'} share a number with another (FinMatrix ignores spaces and punctuation in numbers), so each carries its party's ID: ${renumbered.slice(0, 20).join('; ')}${renumbered.length > 20 ? '; …' : ''}.`,
    );
  const nettedNotes = [...ar.open, ...ap.open].filter((d) => d.netted.length);
  if (nettedNotes.length)
    warnings.push(
      `${nettedNotes.length} open document${nettedNotes.length === 1 ? ' was' : 's were'} reduced by the same party's credits, oldest first: ${nettedNotes
        .slice(0, 20)
        .map((d) => `${d.number} less ${d.netted.join(', ')}`)
        .join('; ')}${nettedNotes.length > 20 ? '; …' : ''}.`,
    );

  return {
    format: 'finmatrix-peachtree-extract',
    version: 1,
    source: {
      peachtreeVersion,
      company,
      firstEntryDate: firstEntry,
      lastEntryDate: lastEntry,
      fiscalYearStartMonth,
      cutoverDate: opts.cutoverDate,
      openingDate: opts.openingDate,
      records,
    },
    grids,
    peachtree: {
      accounts: [...accounts.values()]
        .sort((x, y) => x.id.localeCompare(y.id))
        .map((a) => ({
          id: a.id,
          name: a.name,
          balance: fmt(closing.get(a.record) ?? new Decimal(0)),
          number: numberOf.get(a.record) ?? null,
        })),
      customers: [...customers.values()].map((p) => ({
        id: p.id,
        name: p.name,
        balance: fmt(p.balance),
      })),
      vendors: [...vendors.values()].map((p) => ({
        id: p.id,
        name: p.name,
        balance: fmt(p.balance),
      })),
      items: [...items.values()].map((it) => ({
        sku: it.sku,
        code: it.code,
        name: it.name,
        quantity: (quantities.get(it.record) ?? new Decimal(0)).toString(),
      })),
    },
    stock: {
      inventoryAccount: inventoryControl
        ? (numberOf.get(inventoryControl.record) ?? '')
        : '',
      peachtreeAccount: inventoryControl?.id ?? null,
      ledgerBalance: fmt(
        inventoryControl
          ? (closing.get(inventoryControl.record) ?? new Decimal(0))
          : new Decimal(0),
      ),
      items: stockItems.map(({ it, q }) => ({
        sku: it.sku,
        code: it.code,
        name: it.name,
        quantity: q.toString(),
      })),
    },
    checks,
    findings,
    warnings,
  };
}

/** A sheet with the starter workbook's header row, as the Tally reader builds them. */
export function grid(
  name: string,
  target: string,
  rows: Array<Array<string | null>>,
): Grid {
  const t = TARGET_SHEETS.find((x) => x.key === target);
  if (!t) throw new Error(`no target sheet ${target}`);
  return {
    name,
    rows: [
      { rowNumber: 1, cells: t.fields.map((f) => f.header) },
      ...rows.map((cells, i) => ({ rowNumber: i + 2, cells })),
    ],
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** A Peachtree customer or vendor ID as FinMatrix keeps one (PARTY_CODE_PATTERN). */
export function partyCodeForm(id: string): string {
  return id
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9._/-]+/g, '-')
    .replace(/^[^A-Z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 20);
}

/**
 * Codes FinMatrix will hold apart: each ID in its FinMatrix form, and where
 * that form would equal an earlier one's (as normalizeKey compares them),
 * -2, -3… within `max` characters. Returns the IDs whose code is more than
 * the ID upper-cased.
 */
export function assignCodes<T>(
  list: T[],
  idOf: (x: T) => string,
  form: (id: string) => string,
  max: number,
  set: (x: T, code: string) => void,
): Array<{ id: string; code: string }> {
  const used = new Set<string>();
  const changed: Array<{ id: string; code: string }> = [];
  for (const x of list) {
    const id = idOf(x);
    const base = form(id) || 'X';
    let code = base;
    for (let n = 2; !normalizeKey(code) || used.has(normalizeKey(code)); n++) {
      const suffix = `-${n}`;
      code = base.slice(0, max - suffix.length) + suffix;
    }
    used.add(normalizeKey(code));
    set(x, code);
    if (code.toUpperCase() !== id.trim().toUpperCase())
      changed.push({ id, code });
  }
  return changed;
}

/**
 * Give every member of a repeated name (as normalizeKey compares names — it
 * drops text in brackets, so the code is joined with a dash) its code:
 * "Madina Karyana" twice becomes "Madina Karyana - GHRD015" and
 * "Madina Karyana - GHRD102". Returns the new names.
 */
export function distinctNames<T extends { name: string }>(
  list: T[],
  codeOf: (x: T) => string,
  rename: (x: T, name: string) => void,
): string[] {
  const groups = new Map<string, T[]>();
  for (const x of list) {
    const k = normalizeKey(x.name);
    groups.set(k, [...(groups.get(k) ?? []), x]);
  }
  const used = new Set<string>();
  for (const [k, group] of groups) if (k && group.length === 1) used.add(k);
  const out: string[] = [];
  for (const [k, group] of groups) {
    if (k && group.length === 1) continue;
    for (const x of group) {
      let name = `${x.name} - ${codeOf(x)}`;
      for (let n = 2; used.has(normalizeKey(name)); n++)
        name = `${x.name} - ${codeOf(x)} ${n}`;
      used.add(normalizeKey(name));
      rename(x, name);
      out.push(name);
    }
  }
  return out;
}
