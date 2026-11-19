/**
 * Reads accounting reports exported to Excel or CSV, whatever system printed
 * them, through a profile that says how that system lays them out.
 *
 * A report is recognised by its column titles (in any order, anywhere in the
 * first 40 rows) and, where two reports share titles, a phrase in its title
 * lines. Each row is then one of: a detail line, a party heading (grouped
 * detail reports, e.g. an aged receivables detail), a section heading, a
 * printed total, or blank.
 *
 * Nothing a report prints is taken on trust: every printed total — a party's
 * subtotal, the report total, a trial balance's debit and credit totals —
 * must equal the lines above it, to the paisa, or the report is refused,
 * naming the row. A row FinMatrix misread (skipped, double-counted, a wrong
 * column) therefore cannot pass silently.
 */
import Decimal from 'decimal.js';
import { parseAmount, parseQuantity } from '../../parsers/amount.parser';
import { DateOrder, parseDate } from '../../parsers/date.parser';
import { SourceGrid } from '../../readers/read-upload';
import { TARGET_SHEETS } from '../../targets';
import { normalizeKey } from '../../parsers/text-normalize';

/**
 * A sheet laid out as one of the starter workbook's own: a row in its first
 * few whose titles are (nearly) all that sheet's titles. Sharing a few
 * common titles — "Due date", "Phone", "Invoice number" — is not enough:
 * every system's reports share those.
 */
export function isStarterSheet(g: SourceGrid): boolean {
  return TARGET_SHEETS.some((t) => {
    const titles = new Set(t.fields.map((f) => normalizeKey(f.header)));
    return g.rows.slice(0, 5).some((r) => {
      const cells = r.cells.map((c) => normalizeKey(c)).filter(Boolean);
      const matched = cells.filter((c) => titles.has(c)).length;
      return matched >= Math.min(3, titles.size) && matched >= cells.length * 0.75;
    });
  });
}

export type ReportKind =
  | 'chart_of_accounts'
  | 'customer_list'
  | 'vendor_list'
  | 'item_list'
  | 'trial_balance'
  | 'aged_receivables'
  | 'aged_payables'
  | 'inventory_valuation'
  /** Customers and suppliers in one list (Xero, Zoho Books). */
  | 'contact_list'
  // Recognised so they are named and skipped, never misread as something else.
  | 'general_ledger'
  | 'journal'
  | 'profit_and_loss'
  | 'balance_sheet'
  /** Every invoice or bill, paid or not, line by line (the aging report is used instead). */
  | 'transactions';

/** Reports a migration does not need: listed as skipped. */
export const SKIPPED_KINDS: ReportKind[] = ['general_ledger', 'journal', 'profit_and_loss', 'balance_sheet', 'transactions'];

export const REPORT_KIND_LABEL: Record<ReportKind, string> = {
  chart_of_accounts: 'Chart of accounts',
  customer_list: 'Customer list',
  vendor_list: 'Vendor list',
  item_list: 'Item list',
  trial_balance: 'Trial balance',
  aged_receivables: 'Aged receivables (detail)',
  aged_payables: 'Aged payables (detail)',
  inventory_valuation: 'Inventory valuation',
  contact_list: 'Contact list',
  general_ledger: 'General ledger (not needed)',
  journal: 'Journal (not needed)',
  profit_and_loss: 'Profit and loss (not needed)',
  balance_sheet: 'Balance sheet (not needed)',
  transactions: 'All invoices or bills (not needed: the aging report is used)',
};

/** What a column can hold. Amount fields are summed for printed-total proof. */
export type Field =
  | 'key'
  | 'name'
  | 'type'
  | 'active'
  | 'debit'
  | 'credit'
  | 'balance'
  | 'doc'
  | 'date'
  | 'due'
  | 'original'
  | 'amount'
  | 'qty'
  | 'value'
  | 'cost'
  | 'unit'
  | 'category'
  | 'price'
  | 'phone'
  | 'email'
  | 'address'
  | 'city'
  | 'terms'
  | 'creditLimit'
  | 'taxId'
  | 'party'
  | 'location'
  /** An account's detail type (QuickBooks Online). */
  | 'detail'
  | 'number'
  /** Year-to-date columns of a trial balance (P&L accounts' figures). */
  | 'ytdDebit'
  | 'ytdCredit'
  /** A contact list's marker of customer / supplier. */
  | 'contactType'
  | 'status';

const AMOUNT_FIELDS: Field[] = ['debit', 'credit', 'balance', 'original', 'amount', 'value', 'ytdDebit', 'ytdCredit'];
const QUANTITY_FIELDS: Field[] = ['qty'];
/** Fields whose printed totals are checked. */
const TOTALLED: Field[] = ['debit', 'credit', 'balance', 'amount', 'value', 'qty', 'ytdDebit', 'ytdCredit'];

export interface ReportSpec {
  kind: ReportKind;
  /** Normalised column titles per field (see `norm`). */
  columns: Partial<Record<Field, string[]>>;
  /** Fields that must all be found for the report to be recognised. */
  need: Field[];
  /** A phrase one of which must appear in the title lines above the header. */
  title?: string[];
  /** Party heading rows with their documents below and a total line after. */
  grouped?: boolean;
  /** The key column may hold "number name" (e.g. "1000 · Checking"). */
  accountCell?: boolean;
  /**
   * Detail grouped under section headings (e.g. QuickBooks' aging buckets:
   * "Current", "1 - 30 days past due"), each closed by "Total for …"; the
   * party is a column on every line.
   */
  sections?: boolean;
  /** No title over the key column: it is the left-most untitled column. */
  implicitKey?: boolean;
  /** Sections are parties (Xero's aged detail): the heading names the contact. */
  partyFromSection?: boolean;
}

export interface ReportProfile {
  /** A MigrationSourceSystem id. */
  source: string;
  label: string;
  /** How the system writes a/b/yyyy dates. */
  dateOrder: DateOrder;
  specs: ReportSpec[];
  /**
   * The system's account type names → FinMatrix type and kind. A key
   * "type|detail" (normalised) wins over "type" alone.
   */
  accountTypes: Record<string, { type: string; kind: string }>;
  /** False when the system identifies parties by name, not by a code (QuickBooks). */
  partyCodes?: boolean;
}

export interface ReportLine {
  rowNumber: number;
  key: string;
  name: string | null;
  /** Grouped reports: the party heading this line sits under. */
  group?: { key: string; name: string | null };
  /** Amounts as decimal strings (debit-positive where the field says so), dates ISO, text trimmed. */
  values: Partial<Record<Field, string>>;
}

export interface PrintedTotal {
  rowNumber: number;
  label: string;
  scope: 'group' | 'report';
  group?: string;
  values: Partial<Record<Field, string>>;
  /** What the lines it closes add up to. */
  computed: Partial<Record<Field, string>>;
}

export interface ParsedSourceReport {
  source: string;
  kind: ReportKind;
  sheet: string;
  headerIndex: number;
  asOf: string | null;
  lines: ReportLine[];
  totals: PrintedTotal[];
  /** Printed totals that disagree with their lines, cells that could not be read. */
  problems: string[];
}

export interface Recognised {
  profile: ReportProfile;
  spec: ReportSpec;
  headerIndex: number;
  col: Partial<Record<Field, number>>;
}

/** Lower-case letters and digits, single spaces: "Invoice/CM #" → "invoice cm". */
export const norm = (v: unknown) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const HEADER_ROWS = 40;

/**
 * The report a sheet is, and where its columns are, trying `preferred`'s
 * profiles first. Null when no profile recognises it.
 */
export function recogniseReport(
  grid: SourceGrid,
  profiles: ReportProfile[],
  preferred?: string,
): Recognised | null {
  const ordered = [
    ...profiles.filter((p) => p.source === preferred),
    ...profiles.filter((p) => p.source !== preferred),
  ];
  const head = grid.rows.slice(0, HEADER_ROWS);
  let best: (Recognised & { score: number }) | null = null;
  for (let i = 0; i < head.length; i++) {
    const cells = head[i].cells.map(norm);
    // Title words, matched whole ("cust" is not in "customers").
    const above = ` ${head
      .slice(0, i)
      .flatMap((r) => r.cells.map(norm))
      .join(' ')} `;
    const sheetName = ` ${norm(grid.name)} `;
    for (const profile of ordered) {
      for (const spec of profile.specs) {
        if (spec.title && !spec.title.some((t) => above.includes(` ${t} `) || sheetName.includes(` ${t} `))) continue;
        const col: Partial<Record<Field, number>> = {};
        const taken = new Set<number>();
        let ok = true;
        for (const field of spec.need) {
          const at = cells.findIndex((c, k) => !taken.has(k) && (spec.columns[field] ?? []).includes(c));
          if (at < 0) {
            ok = false;
            break;
          }
          col[field] = at;
          taken.add(at);
        }
        if (!ok) continue;
        if (spec.implicitKey && col.key === undefined) {
          const firstNamed = Math.min(...Object.values(col).filter((v): v is number => v !== undefined));
          const blank = cells.findIndex((c, k) => k < firstNamed && c === '' && !taken.has(k));
          if (blank < 0) continue;
          col.key = blank;
          taken.add(blank);
        }
        for (const [field, names] of Object.entries(spec.columns) as Array<[Field, string[]]>) {
          if (col[field] !== undefined) continue;
          const at = cells.findIndex((c, k) => !taken.has(k) && names.includes(c));
          if (at >= 0) {
            col[field] = at;
            taken.add(at);
          }
        }
        // The more columns a spec explains, the better it fits; a preferred
        // profile wins a tie.
        const score = Object.keys(col).length * 10 + (spec.title ? 5 : 0) + (profile.source === preferred ? 1 : 0);
        if (!best || score > best.score) best = { profile, spec, headerIndex: i, col, score };
      }
    }
  }
  if (!best) return null;
  const { score: _score, ...rest } = best;
  void _score;
  return rest;
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

/**
 * The report's date from its title lines: "As of Sep 30, 2026", "As at
 * 30/09/2026", "As on 30-Sep-2026", or the end of a period ("July 1 –
 * September 30, 2026", "1 Jul 2026 to 30 Sep 2026").
 */
export function reportDate(lines: string[], order: DateOrder): string | null {
  const text = lines.join(' | ');
  // A two-digit year only in "Sep 30, 26" (QuickBooks Desktop), after the comma:
  // elsewhere "1 - September 30, 2026" would read "30" as a year.
  const monthName = /([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:,\s*(\d{4}|\d{2})|\s+(\d{4}))\b|(\d{1,2})(?:st|nd|rd|th)?[\s-]+([a-z]{3})[a-z]*\.?[\s-]+(\d{4})\b/gi;
  const numeric = /(\d{1,4})[/.-](\d{1,2})[/.-](\d{2,4})/g;
  const found: Array<{ at: number; iso: string; marked: boolean }> = [];
  const marked = (at: number) => /\b(as\s+(of|at|on)|to|through|ending|-|–)\s*$/i.test(text.slice(Math.max(0, at - 14), at));
  for (const m of text.matchAll(monthName)) {
    const [mon, day, year] = m[1] ? [m[1], m[2], m[3] ?? m[4]] : [m[6], m[5], m[7]];
    const month = MONTHS.indexOf(mon.toLowerCase()) + 1;
    const y = year.length === 2 ? 2000 + Number(year) : Number(year);
    if (month > 0) found.push({ at: m.index!, iso: iso(y, month, Number(day)), marked: marked(m.index!) });
  }
  for (const m of text.matchAll(numeric)) {
    const r = parseDate(m[0], order);
    if (r.ok && r.iso) found.push({ at: m.index!, iso: r.iso, marked: marked(m.index!) });
  }
  if (!found.length) return null;
  // "As of …" wins; otherwise the latest date (a period's end).
  const asOf = found.filter((f) => f.marked);
  const pool = asOf.length ? asOf : found;
  return pool.reduce((a, b) => (b.iso > a.iso ? b : a)).iso;
}

const isTotalLabel = (v: unknown) => /\btotals?\b/i.test(String(v ?? ''));
/**
 * A report's footer or stamp line, not data: QuickBooks' "Wednesday, Oct 01,
 * 2026 09:15 AM GMT+05:00" and "Accrual Basis …", Sage's "Page 1 of 3",
 * "Printed on …", "Generated …".
 */
const FOOTER =
  /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday),|\b\d{1,2}:\d{2}(:\d{2})?\s*(am|pm)?\b.*\b(gmt|utc|[ap]m)\b|^(cash|accrual) basis\b|^page \d+( of \d+)?$|^(printed|generated|run|report run)( on| at| by)?\b/i;
const textOf = (v: unknown): string =>
  v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '').trim();

/**
 * An account cell as reports print it: "1000 · Checking", "1000 - Cash",
 * "1000 Cash", "Utilities:Gas" (a sub-account), "6100 · Utilities:6110 ·
 * Gas". The account is the last part of a "Parent:Child" path; its number
 * is that part's leading number, if any. `path` is the whole cell, unique
 * where names repeat under different parents.
 */
export function splitAccountCell(cell: string): { number: string | null; name: string; path: string } {
  const path = cell.trim().replace(/\s+/g, ' ');
  const parts = path.split(':').map((p) => p.trim()).filter(Boolean);
  const last = parts.length ? parts[parts.length - 1] : path;
  // "Sales (200)": the code in brackets after the name (Xero).
  const bracketed = /^(.+?)\s*\((\d[\w.\-/]*)\)$/.exec(last);
  if (bracketed) return { number: bracketed[2], name: bracketed[1].trim(), path };
  const m = /^(\d[\d.\-/]*)\s*(?:·|•|-|–)?\s+(.+)$/.exec(last);
  if (m) return { number: m[1], name: m[2].trim(), path };
  if (/^\d[\d.\-/]*$/.test(last)) return { number: last, name: last, path };
  return { number: null, name: last, path };
}

/**
 * A contact list with no customer/supplier column, exported from the
 * customers page or the vendors page on its own (Zoho Books exports each
 * separately), is that list: its file name says which. A combined list
 * keeps its kind, and is placed contact by contact.
 */
function contactListKind(kind: ReportKind, typed: boolean, sheet: string): ReportKind {
  if (kind !== 'contact_list' || typed) return kind;
  const name = ` ${norm(sheet)} `;
  if (/ (vendors?|suppliers?|creditors?) /.test(name)) return 'vendor_list';
  if (/ (customers?|clients?|debtors?) /.test(name)) return 'customer_list';
  return kind;
}

export function parseSourceReport(grid: SourceGrid, r: Recognised): ParsedSourceReport {
  const { spec, profile, headerIndex, col } = r;
  const problems: string[] = [];
  const at = (row: { cells: unknown[] }, f: Field) => (col[f] === undefined ? undefined : row.cells[col[f]!]);
  // A sheet written with decimal commas (1.500,00) writes thousands with dots
  // everywhere, quantities included (1.500 is fifteen hundred there).
  const numericCols = [...AMOUNT_FIELDS, ...QUANTITY_FIELDS].map((f) => col[f]).filter((c): c is number => c !== undefined);
  const texts = grid.rows.slice(headerIndex + 1).flatMap((rw) => numericCols.map((c) => rw.cells[c])).filter((v): v is string => typeof v === 'string');
  const decimalComma =
    texts.some((t) => /\d,\d{1,2}\s*$/.test(t)) && !texts.some((t) => /\d\.\d{1,2}\s*$/.test(t));
  const localised = (raw: unknown) =>
    decimalComma && typeof raw === 'string' && /^[\s\d.]+$/.test(raw.trim()) && /^\d{1,3}(\.\d{3})+$/.test(raw.trim())
      ? raw.replace(/\./g, '')
      : raw;
  const read = (row: { rowNumber: number; cells: unknown[] }, f: Field): string | undefined => {
    const raw = at(row, f);
    if (raw === null || raw === undefined || textOf(raw) === '') return undefined;
    if (AMOUNT_FIELDS.includes(f) || QUANTITY_FIELDS.includes(f) || f === 'cost' || f === 'price' || f === 'creditLimit') {
      const res = (QUANTITY_FIELDS.includes(f) ? parseQuantity : parseAmount)(localised(raw));
      if (!res.ok) {
        problems.push(`${grid.name} row ${row.rowNumber}: "${textOf(raw)}" in ${f} ${res.error}`);
        return undefined;
      }
      if (!res.amount) return undefined;
      const v = new Decimal(res.amount.value);
      return (res.amount.side === 'credit' ? v.negated() : v).toString();
    }
    if (f === 'date' || f === 'due') {
      const d = parseDate(raw, profile.dateOrder);
      if (!d.ok || !d.iso) {
        problems.push(`${grid.name} row ${row.rowNumber}: "${textOf(raw)}" is not a date FinMatrix can read`);
        return undefined;
      }
      return d.iso;
    }
    return textOf(raw);
  };

  const lines: ReportLine[] = [];
  const totals: PrintedTotal[] = [];
  let group: { key: string; name: string | null } | null = null;
  let groupStart = 0;
  const amountsIn = (row: { rowNumber: number; cells: unknown[] }) =>
    TOTALLED.some((f) => col[f] !== undefined && textOf(at(row, f)) !== '');

  for (const row of grid.rows.slice(headerIndex + 1)) {
    const cells = row.cells.map(textOf);
    if (cells.every((c) => c === '')) continue;
    const filledCells = cells.filter((c) => c !== '');
    if (filledCells.length === 1 && FOOTER.test(filledCells[0])) continue;
    if (cells.some(isTotalLabel)) {
      const label = cells.find(isTotalLabel)!;
      const values: Partial<Record<Field, string>> = {};
      for (const f of TOTALLED) {
        const v = read(row, f);
        if (v !== undefined) values[f] = v;
      }
      const heading = group?.key ?? '';
      const inGroup =
        !!group &&
        !/\b(report|grand)\b/i.test(label) &&
        !/^\s*totals?\s*:?\s*$/i.test(label) &&
        (spec.grouped || spec.sections || (heading !== '' && norm(label).includes(norm(heading))));
      const scopeLines = inGroup ? lines.slice(groupStart) : lines;
      const computed: Partial<Record<Field, string>> = {};
      for (const f of Object.keys(values) as Field[]) {
        computed[f] = scopeLines.reduce((t, l) => t.plus(l.values[f] ?? 0), new Decimal(0)).toFixed(2);
      }
      totals.push({
        rowNumber: row.rowNumber,
        label,
        scope: inGroup ? 'group' : 'report',
        group: inGroup ? group!.key : undefined,
        values,
        computed,
      });
      if (inGroup) group = null;
      continue;
    }
    const key = read(row, 'key') ?? '';
    const docNo = read(row, 'doc') ?? '';
    if (spec.sections) {
      const filled = cells.filter((c) => c !== '');
      if (!docNo && !amountsIn(row) && filled.length === 1) {
        group = { key: filled[0], name: filled[0] };
        groupStart = lines.length;
        continue;
      }
      if (!docNo) continue;
      const party = read(row, 'party') ?? (spec.partyFromSection ? group?.key ?? '' : '');
      if (!party) {
        problems.push(`${grid.name} row ${row.rowNumber}: document ${docNo} names no customer or vendor`);
        continue;
      }
      const values: Partial<Record<Field, string>> = {};
      for (const f of Object.keys(col) as Field[]) {
        if (f === 'key') continue;
        const v = read(row, f);
        if (v !== undefined) values[f] = v;
      }
      lines.push({ rowNumber: row.rowNumber, key: party, name: party, group: group ?? undefined, values });
      continue;
    }
    if (spec.grouped) {
      if (key && !docNo && !amountsIn(row)) {
        group = { key, name: read(row, 'name') ?? null };
        groupStart = lines.length;
        continue;
      }
      if (!docNo) continue; // a heading or note inside a group
      if (!group) {
        problems.push(`${grid.name} row ${row.rowNumber}: document ${docNo} is not under any party`);
        continue;
      }
    } else if (!key && !read(row, 'name')) {
      continue;
    } else if ((spec.kind === 'trial_balance' || spec.kind === 'inventory_valuation') && !amountsIn(row)) {
      // A section heading ("Assets", "Inventory", "Grocery"): its subtotal,
      // "Total <heading>", closes it.
      group = { key: key || read(row, 'name') || '', name: null };
      groupStart = lines.length;
      continue;
    }
    const values: Partial<Record<Field, string>> = {};
    for (const f of Object.keys(col) as Field[]) {
      if (f === 'key') continue;
      const v = read(row, f);
      if (v !== undefined) values[f] = v;
    }
    let lineKey = key;
    let name = values.name ?? null;
    if (spec.accountCell && key) {
      const s = splitAccountCell(key);
      const number = values.number ?? s.number;
      lineKey = number ?? s.path;
      name = name ?? s.name;
      if (number) values.number = number;
    }
    lines.push({
      rowNumber: row.rowNumber,
      key: spec.grouped ? group!.key : lineKey,
      name: spec.grouped ? group!.name : name,
      group: spec.grouped ? group! : undefined,
      values,
    });
  }

  // Printed totals must equal their lines.
  for (const t of totals) {
    for (const f of Object.keys(t.values) as Field[]) {
      const printed = new Decimal(t.values[f]!).toDecimalPlaces(2);
      const sum = new Decimal(t.computed[f]!);
      if (!printed.equals(sum)) {
        problems.push(
          `${grid.name} row ${t.rowNumber} ("${t.label}") prints ${f} ${printed.toFixed(2)}, but the lines ${t.scope === 'group' ? `of ${t.group}` : 'above it'} add up to ${sum.toFixed(2)}`,
        );
      }
    }
    const ytd = t.values.ytdDebit !== undefined && t.values.ytdCredit !== undefined;
    if (spec.kind === 'trial_balance' && (ytd || (t.values.debit !== undefined && t.values.credit !== undefined))) {
      const d = new Decimal((ytd ? t.values.ytdDebit : t.values.debit)!);
      const c = new Decimal((ytd ? t.values.ytdCredit : t.values.credit)!);
      if (!d.abs().equals(c.abs())) {
        problems.push(`${grid.name} row ${t.rowNumber}: the trial balance's total debits ${d.toFixed(2)} and credits ${c.abs().toFixed(2)} differ`);
      }
    }
  }
  const titleLines = grid.rows.slice(0, headerIndex).map((rw) => rw.cells.map(textOf).join(' '));
  return {
    source: profile.source,
    kind: contactListKind(spec.kind, col.contactType !== undefined, grid.name),
    sheet: grid.name,
    headerIndex,
    asOf: reportDate([grid.name, ...titleLines], profile.dateOrder),
    lines,
    totals,
    problems,
  };
}
