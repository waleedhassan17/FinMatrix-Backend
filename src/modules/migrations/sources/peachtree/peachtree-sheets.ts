/**
 * The Peachtree backup's extract and Peachtree's own reports, made into the
 * analysis's input: the sheets to import, the issues the owner must see, and
 * the proof rows the eleventh check (SOURCE_REPORTS_MATCH) compares.
 *
 * Pure: no database, no files. The analysis supplies what it knows (the
 * owner's acceptances, the company's fiscal year, the chart) and adds what
 * comes back.
 */
import { createHash } from 'crypto';
import Decimal from 'decimal.js';
import { IssueDraft, MIGRATION_CODES } from '../../issues';
import { SourceGrid } from '../../readers/read-upload';
import { grid, PeachtreeExtract } from './peachtree-books';
import {
  ParsedReport,
  PeachtreeReportKind,
  REPORT_TITLES,
} from './peachtree-reports';

export interface ProofRow {
  /** Which of Peachtree's reports the line is from. */
  source: PeachtreeReportKind;
  key: string;
  name: string | null;
  measure: 'balance' | 'amount_due' | 'quantity';
  /** As read from the backup; null when the backup has no such line. */
  backup: string | null;
  /** As printed by Peachtree's report; null when the report has no such line. */
  printed: string | null;
}

export interface PeachtreeSheets {
  grids: SourceGrid[];
  issues: IssueDraft[];
  proof: ProofRow[];
}

export interface SheetOptions {
  /** Whether the owner accepted the finding `peachtree::<key>`. */
  accepted: (key: string) => boolean;
  /** The company's fiscal year start month, 1–12. */
  fiscalYearStartMonth: number;
  /** Account numbers already in the company's chart. */
  existingAccounts: ReadonlyArray<string>;
  /** The file the backup arrived as, for messages. */
  fileName: string;
}

const MONTH = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const money = (v: Decimal.Value) =>
  new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
const same = (a: string | null, b: string | null) =>
  new Decimal(a ?? 0).equals(new Decimal(b ?? 0));

export function buildPeachtreeSheets(
  extract: PeachtreeExtract,
  reports: ParsedReport[],
  opts: SheetOptions,
): PeachtreeSheets {
  const issues: IssueDraft[] = [];
  const proof: ProofRow[] = [];
  const sheet = opts.fileName;

  // ── The backup's own cross-checks ──────────────────────────────────
  for (const c of extract.checks.filter((x) => !x.passed)) {
    issues.push({
      code: MIGRATION_CODES.PEACHTREE_CROSSCHECK_FAILED,
      severity: 'blocking',
      sheet,
      field: `peachtree::check::${c.code}`,
      message: `${c.label}: expected ${c.expected}, found ${c.actual}. ${describe(c.details)} The backup does not agree with itself, so nothing can be imported from it. Run Peachtree's File → Data Verification, back up again and upload the new backup.`,
    });
  }
  // ── What the owner must accept or fix ──────────────────────────────
  for (const f of extract.findings) {
    if (f.acceptable && opts.accepted(f.key)) continue;
    issues.push({
      code: MIGRATION_CODES[f.code],
      severity: f.severity,
      sheet,
      field: `peachtree::${f.key}`,
      message: f.message,
      options: f.acceptable ? [{ value: 'accept', label: 'Accept' }] : null,
    });
  }
  if (extract.source.fiscalYearStartMonth !== opts.fiscalYearStartMonth) {
    issues.push({
      code: MIGRATION_CODES.PEACHTREE_FISCAL_YEAR,
      severity: 'blocking',
      sheet,
      field: 'peachtree::fiscal-year',
      message: `Peachtree's fiscal year starts in ${MONTH[extract.source.fiscalYearStartMonth - 1]}; this company's in FinMatrix starts in ${MONTH[opts.fiscalYearStartMonth - 1]}. The year-to-date figures would be split at the wrong month. Set the fiscal year to start in ${MONTH[extract.source.fiscalYearStartMonth - 1]} (Settings → Company), then check again.`,
    });
  }

  // ── Peachtree's reports ────────────────────────────────────────────
  const byKind = new Map<PeachtreeReportKind, ParsedReport>();
  for (const r of reports) {
    if (byKind.has(r.kind)) {
      issues.push({
        code: MIGRATION_CODES.PEACHTREE_REPORT_MISMATCH,
        severity: 'blocking',
        sheet: r.sheet,
        field: `peachtree::duplicate::${r.kind}`,
        message: `There are two ${REPORT_TITLES[r.kind]} reports ("${byKind.get(r.kind)!.sheet}" and "${r.sheet}"). Remove one of the files.`,
      });
      continue;
    }
    byKind.set(r.kind, r);
  }
  const required: PeachtreeReportKind[] = [
    'trial_balance',
    'aged_receivables',
    'aged_payables',
  ];
  if (extract.peachtree.items.some((i) => !new Decimal(i.quantity).isZero()))
    required.push('inventory_valuation');
  const missing = required.filter((k) => !byKind.has(k));
  if (missing.length) {
    issues.push({
      code: MIGRATION_CODES.PEACHTREE_REPORTS_MISSING,
      severity: 'blocking',
      sheet: null,
      field: 'peachtree::reports',
      message: `Upload ${missing.length === 1 ? 'this report' : 'these reports'} from Peachtree, exported to Excel as of ${extract.source.openingDate}: ${missing.map((k) => REPORT_TITLES[k]).join(', ')}. They are the proof that what FinMatrix read from the backup is what Peachtree prints${missing.includes('inventory_valuation') ? ', and the valuation gives each item its value' : ''}.`,
    });
  }
  for (const r of byKind.values()) {
    if (r.asOf && r.asOf !== extract.source.openingDate) {
      issues.push({
        code: MIGRATION_CODES.PEACHTREE_REPORT_MISMATCH,
        severity: 'blocking',
        sheet: r.sheet,
        field: `peachtree::as-of::${r.kind}`,
        message: `The ${REPORT_TITLES[r.kind]} is as of ${r.asOf}; it must be as of ${extract.source.openingDate}, the close of the day before the cutover. Run it again in Peachtree for that date.`,
      });
    }
    for (const p of r.problems.slice(0, 5)) {
      issues.push({
        code: MIGRATION_CODES.PEACHTREE_REPORT_MISMATCH,
        severity: 'blocking',
        sheet: r.sheet,
        field: `peachtree::cell::${createHash('sha256').update(p).digest('hex').slice(0, 24)}`,
        message: `${p}. Export the report from Peachtree again, unchanged.`,
      });
    }
  }

  // ── Proof: the backup line by line against each report ─────────────
  const compare = (
    kind: PeachtreeReportKind,
    measure: ProofRow['measure'],
    backup: Array<{ key: string; name: string | null; value: string }>,
    pick: (l: ParsedReport['lines'][number]) => string | null,
  ) => {
    const report = byKind.get(kind);
    if (!report) return;
    const paired = pairByKey(backup, report.lines);
    for (const b of backup) {
      const l = paired.get(b) ?? null;
      if (!l && new Decimal(b.value).isZero()) continue;
      proof.push({
        source: kind,
        key: b.key,
        name: b.name,
        measure,
        backup: b.value,
        printed: l ? pick(l) : null,
      });
    }
    const claimed = new Set(paired.values());
    for (const l of report.lines) {
      if (claimed.has(l)) continue;
      const v = pick(l);
      if (v !== null && new Decimal(v).isZero()) continue;
      proof.push({
        source: kind,
        key: l.key,
        name: l.name,
        measure,
        backup: null,
        printed: v,
      });
    }
  };
  compare(
    'trial_balance',
    'balance',
    extract.peachtree.accounts.map((a) => ({
      key: a.id,
      name: a.name,
      value: a.balance,
    })),
    (l) => l.amount,
  );
  compare(
    'aged_receivables',
    'amount_due',
    extract.peachtree.customers.map((p) => ({
      key: p.id,
      name: p.name,
      value: p.balance,
    })),
    (l) => l.amount,
  );
  compare(
    'aged_payables',
    'amount_due',
    extract.peachtree.vendors.map((p) => ({
      key: p.id,
      name: p.name,
      value: p.balance,
    })),
    (l) => l.amount,
  );
  compare(
    'inventory_valuation',
    'quantity',
    extract.peachtree.items.map((i) => ({
      key: i.sku,
      name: i.name,
      value: i.quantity,
    })),
    (l) => l.quantity,
  );
  const differ = proof.filter((p) => !same(p.backup, p.printed));
  if (differ.length) {
    issues.push({
      code: MIGRATION_CODES.PEACHTREE_REPORT_MISMATCH,
      severity: 'blocking',
      sheet: null,
      field: 'peachtree::proof',
      message: `${differ.length} line${differ.length === 1 ? '' : 's'} of Peachtree's reports ${differ.length === 1 ? 'differs' : 'differ'} from the backup: ${differ
        .slice(0, 8)
        .map(
          (p) =>
            `${REPORT_TITLES[p.source]} ${p.key}: backup ${p.backup ?? 'none'}, report ${p.printed ?? 'none'}`,
        )
        .join(
          '; ',
        )}${differ.length > 8 ? '; …' : ''}. The reports and the backup must be from the same company on the same date.`,
    });
  }

  // ── Sheets: the backup's, and stock from the valuation ─────────────
  const grids: SourceGrid[] = extract.grids.map((g) => ({
    name: g.name,
    rows: g.rows.map((r) => ({ rowNumber: r.rowNumber, cells: [...r.cells] })),
  }));
  const valuation = byKind.get('inventory_valuation');
  if (valuation) {
    // The report names items by Peachtree ID; the Items sheet by FinMatrix SKU.
    const backupItems = extract.peachtree.items.map((i) => ({
      key: i.sku,
      code: i.code ?? i.sku,
    }));
    const itemOf = pairByKey(backupItems, valuation.lines);
    const skuOf = new Map([...itemOf].map(([b, l]) => [l, b.code]));
    const stockRows: Array<Array<string | null>> = [];
    let total = new Decimal(0);
    for (const l of valuation.lines) {
      const qty = new Decimal(l.quantity ?? 0);
      const value = money(l.amount ?? 0);
      if (qty.isZero() && value.isZero()) continue;
      if (qty.lessThanOrEqualTo(0) || value.lessThan(0)) {
        issues.push({
          code: MIGRATION_CODES.PEACHTREE_REPORT_MISMATCH,
          severity: 'blocking',
          sheet: valuation.sheet,
          field: `peachtree::stock::${l.key}`,
          message: `${l.key}: Peachtree values ${qty.toString()} on hand at Rs ${value.toFixed(2)}. FinMatrix cannot open with stock that is negative, or valued without any on hand. Correct it in Peachtree (an inventory adjustment) and export the report again.`,
        });
        continue;
      }
      total = total.plus(value);
      stockRows.push([
        skuOf.get(l) ?? l.key,
        qty.toString(),
        value
          .dividedBy(qty)
          .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
          .toFixed(4),
        value.toFixed(2),
      ]);
    }
    if (stockRows.length)
      grids.push(grid('Stock (Peachtree)', 'stock', stockRows));
    const ledger = money(extract.stock.ledgerBalance);
    const diff = ledger.minus(total);
    if (!diff.isZero()) {
      const key = 'inventory-difference';
      if (opts.accepted(key)) {
        const tb = grids.find((g) => g.name.startsWith('Trial Balance'));
        const accounts = grids.find((g) => g.name.startsWith('Accounts'));
        const line = tb?.rows.find(
          (r) =>
            r.rowNumber > 1 && r.cells[0] === extract.stock.inventoryAccount,
        );
        if (tb && accounts && line) {
          const used = new Set([
            ...opts.existingAccounts,
            ...accounts.rows.slice(1).map((r) => String(r.cells[0])),
          ]);
          let n = 18001;
          while (used.has(String(n))) n++;
          const number = String(n);
          const name = `Inventory not on any item (from Peachtree ${extract.stock.peachtreeAccount ?? extract.stock.inventoryAccount})`;
          accounts.rows.push({
            rowNumber: accounts.rows.length + 1,
            cells: [number, name, 'Asset', 'Other Asset', null],
          });
          line.cells[2] = total.greaterThan(0) ? total.toFixed(2) : null;
          line.cells[3] = total.lessThan(0) ? total.negated().toFixed(2) : null;
          tb.rows.push({
            rowNumber: tb.rows.length + 1,
            cells: [
              number,
              name,
              diff.greaterThan(0) ? diff.toFixed(2) : null,
              diff.lessThan(0) ? diff.negated().toFixed(2) : null,
            ],
          });
        }
      } else {
        issues.push({
          code: MIGRATION_CODES.PEACHTREE_CONTROL_DIFFERENCE,
          severity: 'blocking',
          sheet: valuation.sheet,
          field: `peachtree::${key}`,
          message: `Peachtree's inventory account holds Rs ${ledger.toFixed(2)}, its items Rs ${total.toFixed(2)} (Inventory Valuation): the account is Rs ${diff.abs().toFixed(2)} ${diff.greaterThan(0) ? 'higher' : 'lower'} than its items, from entries posted straight to it. The difference will be kept on its own account, "Inventory not on any item", for you to clear. Accept, or correct it in Peachtree and upload a new backup and report.`,
          options: [{ value: 'accept', label: 'Accept' }],
        });
      }
    }
  }
  return { grids, issues, proof };
}

/**
 * Each backup entry's line in a report. Peachtree prints its IDs as it keeps
 * them, so an ID matches exactly; failing that, and only where it is
 * unambiguous, ignoring capitals and (for an all-digit ID) leading zeros,
 * which a spreadsheet can drop.
 */
export function pairByKey<B extends { key: string }, L extends { key: string }>(
  backup: B[],
  lines: L[],
): Map<B, L> {
  const out = new Map<B, L>();
  const exact = new Map<string, L>();
  for (const l of lines) if (!exact.has(l.key)) exact.set(l.key, l);
  const claimed = new Set<L>();
  const pending: B[] = [];
  for (const b of backup) {
    const l = exact.get(b.key);
    if (l && !claimed.has(l)) {
      out.set(b, l);
      claimed.add(l);
    } else pending.push(b);
  }
  const loose = (k: string) => {
    const u = k.trim().toUpperCase();
    return /^\d+$/.test(u) ? u.replace(/^0+(?=\d)/, '') : u;
  };
  const group = <T extends { key: string }>(xs: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of xs)
      m.set(loose(x.key), [...(m.get(loose(x.key)) ?? []), x]);
    return m;
  };
  const restLines = group(lines.filter((l) => !claimed.has(l)));
  const restBackup = group(pending);
  for (const b of pending) {
    const k = loose(b.key);
    const ls = restLines.get(k) ?? [];
    if (ls.length === 1 && restBackup.get(k)?.length === 1) out.set(b, ls[0]);
  }
  return out;
}

function describe(details: Array<Record<string, unknown>>): string {
  const shown = details.filter((d) => !('note' in d)).slice(0, 3);
  return shown.length
    ? `First differences: ${shown
        .map((d) =>
          Object.entries(d)
            .map(([k, v]) => `${k} ${String(v)}`)
            .join(', '),
        )
        .join('; ')}.`
    : '';
}
