/**
 * Peachtree's own reports, exported to Excel: the proof that what FinMatrix
 * read from the backup is what Peachtree itself prints.
 *
 *   General Ledger Trial Balance   Account ID · Account Description · Debit Amt · Credit Amt
 *   Aged Receivables               Customer ID · Customer · Invoice/CM # · Date · … · Amount Due
 *   Aged Payables                  Vendor ID · Vendor · Invoice/CM # · Date · … · Amount Due
 *   Inventory Valuation Report     Item ID · Item Description · … · Qty on Hand · Item Value · Avg Cost
 *
 * A report is recognised by those column titles anywhere in its first rows
 * (an export starts with the company name, the report title and "As of …").
 * Aged reports list a party once, on the first line of its block, with its
 * documents on the lines below and a total line after them; a document line
 * is one that carries a document number, and only those are added up, so the
 * total lines can never be counted twice.
 */
import Decimal from 'decimal.js';
import { parseAmount, parseQuantity } from '../../parsers/amount.parser';
import { SourceGrid } from '../../readers/read-upload';

export type PeachtreeReportKind =
  | 'trial_balance'
  | 'aged_receivables'
  | 'aged_payables'
  | 'inventory_valuation';

export const REPORT_TITLES: Record<PeachtreeReportKind, string> = {
  trial_balance: 'General Ledger Trial Balance',
  aged_receivables: 'Aged Receivables',
  aged_payables: 'Aged Payables',
  inventory_valuation: 'Inventory Valuation Report',
};

export interface ReportLine {
  /** Account ID, customer ID, vendor ID or item ID, as Peachtree prints it. */
  key: string;
  name: string | null;
  /** Debit-positive balance (TB), amount due (aged), item value (valuation). */
  amount: string | null;
  /** Inventory valuation only. */
  quantity: string | null;
  /** Aged reports: documents added up for this party. */
  documents?: number;
}

export interface ParsedReport {
  kind: PeachtreeReportKind;
  sheet: string;
  /** The "As of" date in the report's title, when it has one. */
  asOf: string | null;
  lines: ReportLine[];
  /** Cells that could not be read, with where they are. */
  problems: string[];
}

const norm = (v: unknown) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

interface Layout {
  kind: PeachtreeReportKind;
  headerIndex: number;
  col: Record<string, number>;
}

const SIGNATURES: Array<{
  kind: PeachtreeReportKind;
  need: Record<string, string[]>;
  optional?: Record<string, string[]>;
}> = [
  {
    kind: 'trial_balance',
    need: {
      key: ['account id'],
      debit: ['debit amt', 'debit amount', 'debit'],
      credit: ['credit amt', 'credit amount', 'credit'],
    },
    optional: { name: ['account description', 'description'] },
  },
  {
    kind: 'aged_receivables',
    need: { key: ['customer id'], due: ['amount due'] },
    optional: {
      name: ['customer', 'customer name'],
      doc: ['invoice cm', 'invoice cm no', 'invoice', 'reference'],
    },
  },
  {
    kind: 'aged_payables',
    need: { key: ['vendor id'], due: ['amount due'] },
    optional: {
      name: ['vendor', 'vendor name'],
      doc: ['invoice cm', 'invoice cm no', 'invoice', 'reference'],
    },
  },
  {
    kind: 'inventory_valuation',
    need: {
      key: ['item id'],
      qty: ['qty on hand', 'quantity on hand', 'qty on hand stocking u m'],
      value: ['item value', 'value'],
    },
    optional: { name: ['item description', 'description'] },
  },
];

/** The report a sheet is, and where its columns are; null for anything else. */
export function detectPeachtreeReport(grid: SourceGrid): Layout | null {
  const head = grid.rows.slice(0, 30);
  for (let i = 0; i < head.length; i++) {
    const cells = head[i].cells.map(norm);
    for (const sig of SIGNATURES) {
      const col: Record<string, number> = {};
      let ok = true;
      for (const [field, names] of Object.entries(sig.need)) {
        const at = cells.findIndex((c) => names.includes(c));
        if (at < 0) {
          ok = false;
          break;
        }
        col[field] = at;
      }
      if (!ok) continue;
      for (const [field, names] of Object.entries(sig.optional ?? {})) {
        const at = cells.findIndex((c) => names.includes(c));
        if (at >= 0) col[field] = at;
      }
      return { kind: sig.kind, headerIndex: i, col };
    }
  }
  return null;
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];

/** "As of Oct 5, 2026" / "As of 10/5/26" in the title rows, as ISO. */
function asOfDate(grid: SourceGrid, until: number): string | null {
  for (const r of grid.rows.slice(0, until)) {
    for (const c of r.cells) {
      const text = c instanceof Date ? '' : String(c ?? '');
      let m = /as of\s+([a-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(text);
      if (m) {
        const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
        if (month > 0) return iso(Number(m[3]), month, Number(m[2]));
      }
      m = /as of\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i.exec(text);
      if (m) {
        const y = Number(m[3]) < 100 ? 2000 + Number(m[3]) : Number(m[3]);
        return iso(y, Number(m[1]), Number(m[2]));
      }
    }
  }
  return null;
}

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

const isTotal = (v: unknown) => /\btotal\b/i.test(String(v ?? ''));
const text = (v: unknown) => {
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : String(v ?? '');
  return s.trim();
};

export function parsePeachtreeReport(
  grid: SourceGrid,
  layout: Layout,
): ParsedReport {
  const problems: string[] = [];
  const amountAt = (
    row: { rowNumber: number; cells: unknown[] },
    col: number | undefined,
    label: string,
    quantity = false,
  ): Decimal | null => {
    if (col === undefined) return null;
    const raw = row.cells[col];
    if (raw === null || raw === undefined || text(raw) === '') return null;
    const r = (quantity ? parseQuantity : parseAmount)(raw);
    if (!r.ok) {
      problems.push(
        `${grid.name} row ${row.rowNumber}: ${label} "${text(raw)}" ${r.error}`,
      );
      return null;
    }
    if (!r.amount) return null;
    const v = new Decimal(r.amount.value);
    return r.amount.side === 'credit' ? v.negated() : v;
  };
  const rows = grid.rows.slice(layout.headerIndex + 1);
  const c = layout.col;
  const lines = new Map<string, ReportLine & { sum: Decimal; qty: Decimal }>();
  const line = (key: string, name: string | null) => {
    let l = lines.get(key);
    if (!l) {
      l = {
        key,
        name,
        amount: null,
        quantity: null,
        documents: 0,
        sum: new Decimal(0),
        qty: new Decimal(0),
      };
      lines.set(key, l);
    }
    if (!l.name && name) l.name = name;
    return l;
  };

  if (
    layout.kind === 'trial_balance' ||
    layout.kind === 'inventory_valuation'
  ) {
    for (const row of rows) {
      const key = text(row.cells[c.key]);
      if (!key || isTotal(key) || row.cells.some(isTotal)) continue;
      const name =
        c.name !== undefined ? text(row.cells[c.name]) || null : null;
      const l = line(key, name);
      if (layout.kind === 'trial_balance') {
        const dr = amountAt(row, c.debit, 'debit') ?? new Decimal(0);
        const cr = amountAt(row, c.credit, 'credit') ?? new Decimal(0);
        l.sum = l.sum.plus(dr.abs()).minus(cr.abs());
      } else {
        l.qty = l.qty.plus(amountAt(row, c.qty, 'quantity', true) ?? 0);
        l.sum = l.sum.plus(amountAt(row, c.value, 'value') ?? 0);
      }
    }
  } else {
    let current: string | null = null;
    let currentName: string | null = null;
    for (const row of rows) {
      const id = text(row.cells[c.key]);
      if (id && !isTotal(id)) {
        current = id;
        currentName =
          c.name !== undefined ? text(row.cells[c.name]) || null : null;
        line(current, currentName);
      }
      if (!current || row.cells.some(isTotal)) continue;
      // Only document lines add up: a party's total line has no number.
      const doc = c.doc !== undefined ? text(row.cells[c.doc]) : 'x';
      if (!doc) continue;
      const due = amountAt(row, c.due, 'amount due');
      if (due === null) continue;
      const l = line(current, currentName);
      l.sum = l.sum.plus(due);
      l.documents = (l.documents ?? 0) + 1;
    }
  }
  return {
    kind: layout.kind,
    sheet: grid.name,
    asOf: asOfDate(grid, layout.headerIndex + 1),
    lines: [...lines.values()].map(({ sum, qty, ...l }) => ({
      ...l,
      amount: sum.toDecimalPlaces(2).toFixed(2),
      quantity: layout.kind === 'inventory_valuation' ? qty.toString() : null,
    })),
    problems,
  };
}
