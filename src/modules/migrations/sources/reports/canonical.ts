/**
 * Turns a source's parsed reports into the starter workbook's sheets
 * (accounts, customers, vendors, items, trial balance, open invoices, open
 * bills, stock), so the rest of the Migration Center — matching, issues, the
 * eleven checks, commit, undo — treats them exactly like a filled-in workbook.
 *
 * It refuses rather than guesses: a printed total that disagrees with its
 * lines, a report of the wrong date, a report missing for a balance the
 * trial balance carries, an account type it does not know — each is a
 * blocking issue naming the report and row. Credits a party holds beyond
 * its open documents are netted oldest-first, and anything left is held on
 * an advances account only when the owner accepts it.
 */
import { createHash } from 'crypto';
import Decimal from 'decimal.js';
import { IssueDraft, MIGRATION_CODES } from '../../issues';
import { normalizeKey } from '../../parsers/text-normalize';
import { SourceGrid } from '../../readers/read-upload';
import { grid } from '../peachtree/peachtree-books';
import {
  Field,
  norm,
  ParsedSourceReport,
  REPORT_KIND_LABEL,
  ReportKind,
  ReportLine,
  ReportProfile,
  SKIPPED_KINDS,
} from './report-engine';

/** Where FinMatrix numbers accounts that come without numbers (as the Tally reader does). */
const NEW_ACCOUNT_BASE: Record<string, number> = {
  Asset: 18001,
  Liability: 28001,
  Equity: 38001,
  Revenue: 48001,
  Expense: 68001,
};
/** FinMatrix's own control accounts, where a fresh company has them. */
const DEFAULT_CONTROL_NUMBER: Record<string, string> = {
  'Accounts Receivable': '1100',
  Inventory: '1200',
  'Accounts Payable': '2000',
  'Retained Earnings': '3100',
};
const isNumber = (k: string) => /^\d[\d.\-/]*$/.test(k);

/** A finer kind from what an account is called or its detail type, where the type alone is too broad. */
function refineKind(
  t: { type: string; kind: string },
  name: string,
  detail: string | undefined,
) {
  const text = `${name} ${detail ?? ''}`;
  if (
    t.type === 'Asset' &&
    /\binventory\b/i.test(text) &&
    t.kind !== 'Inventory'
  )
    return { ...t, kind: 'Inventory' };
  if (
    t.type === 'Asset' &&
    t.kind === 'Bank' &&
    /\b(cash on hand|cash in hand|petty cash|cash)\b/i.test(name)
  )
    return { ...t, kind: 'Cash' };
  if (t.type === 'Equity' && /retained earnings/i.test(text))
    return { ...t, kind: 'Retained Earnings' };
  if (
    t.type === 'Asset' &&
    /\b(accounts receivable|trade debtors|debtors control)\b/i.test(name)
  )
    return { ...t, kind: 'Accounts Receivable' };
  if (
    t.type === 'Liability' &&
    /\b(accounts payable|trade creditors|creditors control)\b/i.test(name)
  )
    return { ...t, kind: 'Accounts Payable' };
  if (t.type === 'Equity' && /opening balance equity/i.test(text))
    return { ...t, kind: 'Opening Balance Equity' };
  return t;
}

export interface SourceProofLine {
  /** The report the total was printed on. */
  kind: ReportKind;
  report: string;
  key: string;
  name: string | null;
  measure: string;
  /** What FinMatrix read (the lines). */
  backup: string;
  /** What the report printed. */
  printed: string;
}

export interface CanonicalResult {
  grids: SourceGrid[];
  issues: IssueDraft[];
  warnings: string[];
  proof: SourceProofLine[];
}

export interface CanonicalOptions {
  openingDate: string;
  /** Whether the owner accepted the decision `report::<key>`. */
  accepted: (key: string) => boolean;
  /** Account numbers already in the company's chart. */
  existingAccounts: string[];
  /**
   * Where this company keeps its control accounts now, by kind ('Accounts
   * Receivable', 'Inventory', 'Accounts Payable', 'Retained Earnings'). A
   * source without numbers lands on them; a company that already moved them
   * (an earlier migration, a renumber) keeps them where they are.
   */
  controlNumbers?: Partial<Record<string, string>>;
}

const D = (v: Decimal.Value) => new Decimal(v);
const money = (v: Decimal.Value) =>
  D(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed(2);
const hash = (s: string) =>
  createHash('sha256').update(s).digest('hex').slice(0, 16);
/** Reports that carry balances at a date, which must be the opening date. */
const DATED: ReportKind[] = [
  'trial_balance',
  'aged_receivables',
  'aged_payables',
  'inventory_valuation',
];

export function buildCanonical(
  reports: ParsedSourceReport[],
  profile: ReportProfile,
  opts: CanonicalOptions,
): CanonicalResult {
  const issues: IssueDraft[] = [];
  const warnings: string[] = [];
  const proof: SourceProofLine[] = [];
  const label = profile.label;
  const block = (
    code: IssueDraft['code'],
    field: string,
    message: string,
    sheet: string | null = null,
    options?: IssueDraft['options'],
  ) =>
    issues.push({
      code,
      severity: 'blocking',
      sheet,
      field: `report::${field}`,
      message,
      options,
    });

  // One of each report.
  const byKind = new Map<ReportKind, ParsedSourceReport>();
  for (const r of reports) {
    if (SKIPPED_KINDS.includes(r.kind)) continue;
    const other = byKind.get(r.kind);
    if (other) {
      block(
        MIGRATION_CODES.SOURCE_REPORT_DUPLICATE,
        `duplicate::${r.kind}`,
        `Two ${REPORT_KIND_LABEL[r.kind]} reports were uploaded ("${other.sheet}" and "${r.sheet}"). Remove one.`,
        r.sheet,
      );
      continue;
    }
    byKind.set(r.kind, r);
  }

  // Every report must be read cleanly, add up to its own totals, and (for
  // balances) be as of the opening date.
  const reportDates = new Set(
    [...byKind.values()]
      .filter((r) => DATED.includes(r.kind) && r.asOf)
      .map((r) => r.asOf!),
  );
  const sharedDate = reportDates.size === 1 ? [...reportDates][0] : null;
  for (const r of byKind.values()) {
    r.problems
      .slice(0, 10)
      .forEach((p) =>
        block(
          MIGRATION_CODES.SOURCE_TOTALS_MISMATCH,
          `problem::${hash(p)}`,
          `${p}. Export the report again from ${label}, unchanged.`,
          r.sheet,
        ),
      );
    for (const t of r.totals) {
      for (const f of Object.keys(t.values) as Field[]) {
        proof.push({
          kind: r.kind,
          report: `${label} ${REPORT_KIND_LABEL[r.kind]}`,
          key: `row ${t.rowNumber}`,
          name: t.label,
          measure: f,
          backup: money(t.computed[f]!),
          printed: money(t.values[f]!),
        });
      }
    }
    if (!DATED.includes(r.kind)) continue;
    if (r.asOf && r.asOf !== opts.openingDate) {
      // Every report on one other date: most likely the cutover date was
      // chosen wrongly, and one click puts it right.
      const cutover =
        sharedDate && sharedDate === r.asOf ? dayAfter(sharedDate) : null;
      block(
        MIGRATION_CODES.SOURCE_REPORT_DATE,
        `date::${r.kind}`,
        `The ${REPORT_KIND_LABEL[r.kind]} is as of ${r.asOf}; it must be as of ${opts.openingDate}, the day before your cutover. ${
          cutover
            ? `Every report you uploaded is as of ${r.asOf}: if your books move to FinMatrix on ${cutover}, change the cutover date. Otherwise run the reports again in ${label} as of ${opts.openingDate} and upload them again.`
            : `Run it again in ${label} for that date and upload it again.`
        }`,
        r.sheet,
        cutover
          ? [
              {
                value: `cutover:${cutover}`,
                label: `Change the cutover date to ${cutover} (the reports are as of ${r.asOf})`,
              },
            ]
          : undefined,
      );
    } else if (!r.asOf && !opts.accepted(`date::${r.kind}`)) {
      block(
        MIGRATION_CODES.SOURCE_REPORT_DATE,
        `date::${r.kind}`,
        `"${r.sheet}" does not show its date. Confirm it is your ${REPORT_KIND_LABEL[r.kind]} as of ${opts.openingDate}, the day before your cutover, or export it again with the date in its title.`,
        r.sheet,
        [{ value: 'accept', label: `It is as of ${opts.openingDate}` }],
      );
    }
  }

  const grids: SourceGrid[] = [];
  const name = (s: string) => `${s} (${label})`;

  // ── Accounts ─────────────────────────────────────────────────────────
  const chart = byKind.get('chart_of_accounts');
  const kindOf = new Map<string, { type: string; kind: string }>();
  const accountRows: Array<Array<string | null>> = [];
  if (chart) {
    const unknown = new Set<string>();
    for (const l of chart.lines) {
      const base =
        profile.accountTypes[
          `${norm(l.values.type)}|${norm(l.values.detail)}`
        ] ?? profile.accountTypes[norm(l.values.type)];
      if (!base) {
        unknown.add(l.values.type ?? '(blank)');
        continue;
      }
      if (base.type === 'skip') continue; // non-posting accounts carry no balance
      const t = refineKind(base, l.name ?? l.key, l.values.detail);
      kindOf.set(l.key, t);
      accountRows.push([l.key, l.name ?? l.key, t.type, t.kind, null]);
    }
    if (unknown.size)
      block(
        MIGRATION_CODES.UNKNOWN_ACCOUNT,
        `types::${hash([...unknown].join('|'))}`,
        `The chart of accounts uses account types FinMatrix does not know: ${[...unknown].join(', ')}. Tell support the type names, or add those accounts' types in the starter workbook.`,
        chart.sheet,
      );
  }

  // ── Trial balance ────────────────────────────────────────────────────
  const tb = byKind.get('trial_balance');
  const tbRows: Array<Array<string | null>> = [];
  const balanceOf = new Map<string, Decimal>();
  if (tb) {
    // The year-to-date pair is the one that balances (balance-sheet accounts
    // to date, profit and loss from the year's start): use it for every line.
    const hasYtd = tb.lines.some(
      (l) =>
        l.values.ytdDebit !== undefined || l.values.ytdCredit !== undefined,
    );
    for (const l of tb.lines) {
      const v = hasYtd
        ? D(l.values.ytdDebit ?? 0)
            .abs()
            .minus(D(l.values.ytdCredit ?? 0).abs())
        : l.values.balance !== undefined
          ? D(l.values.balance)
          : D(l.values.debit ?? 0)
              .abs()
              .minus(D(l.values.credit ?? 0).abs());
      balanceOf.set(l.key, (balanceOf.get(l.key) ?? D(0)).plus(v));
    }
    for (const l of tb.lines) {
      if (tbRows.some((r) => r[0] === l.key)) continue;
      const v = balanceOf.get(l.key)!;
      tbRows.push([
        l.key,
        l.name ?? null,
        v.greaterThan(0) ? money(v) : null,
        v.lessThan(0) ? money(v.negated()) : null,
      ]);
    }
  }
  const controlBalance = (kind: string) =>
    [...kindOf.entries()]
      .filter(([, k]) => k.kind === kind)
      .reduce((t, [n]) => t.plus(balanceOf.get(n) ?? 0), D(0));

  // Required reports for what the books hold.
  const missing: string[] = [];
  if (!tb) missing.push(REPORT_KIND_LABEL.trial_balance);
  if (!chart) missing.push(REPORT_KIND_LABEL.chart_of_accounts);
  if (chart && tb) {
    if (
      !controlBalance('Accounts Receivable').isZero() &&
      !byKind.has('aged_receivables')
    )
      missing.push(REPORT_KIND_LABEL.aged_receivables);
    if (
      !controlBalance('Accounts Payable').isZero() &&
      !byKind.has('aged_payables')
    )
      missing.push(REPORT_KIND_LABEL.aged_payables);
    if (
      !controlBalance('Inventory').isZero() &&
      !byKind.has('inventory_valuation')
    )
      missing.push(REPORT_KIND_LABEL.inventory_valuation);
  }
  if (missing.length)
    block(
      MIGRATION_CODES.SOURCE_REPORTS_MISSING,
      'missing',
      `Still needed from ${label}: ${missing.join(', ')}, as of ${opts.openingDate}. The step-by-step guide shows where each report is.`,
    );

  // ── Parties, open documents ──────────────────────────────────────────
  // Systems that name parties (QuickBooks) write a job as "Customer:Job";
  // FinMatrix has no jobs, so a job's documents belong to its customer.
  const byName = profile.partyCodes === false;
  const topParty = (k: string) => (byName ? k.split(':')[0].trim() : k);
  const jobs = new Set<string>();
  for (const kind of [
    'customer_list',
    'vendor_list',
    'aged_receivables',
    'aged_payables',
  ] as const) {
    const r = byKind.get(kind);
    if (!r || !byName) continue;
    r.lines = r.lines.filter((l) => {
      if (!l.key.includes(':')) return true;
      jobs.add(l.key);
      if (kind === 'customer_list' || kind === 'vendor_list') return false;
      l.key = topParty(l.key);
      l.name = l.key;
      return true;
    });
  }
  if (jobs.size)
    warnings.push(
      `${jobs.size} job${jobs.size === 1 ? '' : 's'} (${[...jobs].slice(0, 5).join(', ')}${jobs.size > 5 ? ', …' : ''}) brought in under ${jobs.size === 1 ? 'its customer' : 'their customers'}: FinMatrix keeps documents per customer.`,
    );
  const contacts = byKind.get('contact_list');
  const parties = (
    list: ParsedSourceReport | undefined,
    aged: ParsedSourceReport | undefined,
    kind: 'customer' | 'vendor',
  ): Array<Array<string | null>> => {
    const rows = new Map<string, Array<string | null>>();
    // A combined contact list gives the details of every party; its type
    // column (where there is one) says which side each belongs to.
    const fromContacts = (contacts?.lines ?? []).filter((l) => {
      const t = norm(l.values.contactType);
      return (
        !t ||
        (kind === 'customer'
          ? /customer|client|debtor/.test(t)
          : /vendor|supplier|creditor/.test(t))
      );
    });
    const agedNames = new Set(
      (aged?.lines ?? []).map((l) => normalizeKey(l.key)),
    );
    const listed = [
      ...(list?.lines ?? []),
      ...fromContacts.filter((l) =>
        !norm(l.values.contactType)
          ? agedNames.has(normalizeKey(l.key)) ||
            agedNames.has(normalizeKey(l.name))
          : true,
      ),
    ];
    for (const l of listed) {
      const v = l.values;
      const terms = v.terms ?? null;
      const base = [
        l.key,
        l.name ?? l.key,
        v.phone ?? null,
        v.email ?? null,
        v.address ?? null,
        v.city ?? null,
        terms,
      ];
      rows.set(
        l.key,
        kind === 'customer'
          ? [...base, v.creditLimit ?? null, v.taxId ?? null]
          : [...base, v.taxId ?? null],
      );
    }
    for (const l of aged?.lines ?? []) {
      if (rows.has(l.key)) continue;
      const base = [l.key, l.name ?? l.key, null, null, null, null, null];
      rows.set(
        l.key,
        kind === 'customer' ? [...base, null, null] : [...base, null],
      );
    }
    return [...rows.values()];
  };
  const customerRows = parties(
    byKind.get('customer_list'),
    byKind.get('aged_receivables'),
    'customer',
  );
  const vendorRows = parties(
    byKind.get('vendor_list'),
    byKind.get('aged_payables'),
    'vendor',
  );
  // A contact list without a customer/supplier column (Xero's) places a
  // contact only by its open documents; one with none cannot be placed, and
  // is named rather than guessed.
  if (contacts) {
    const placed = new Set(
      [...customerRows, ...vendorRows]
        .flatMap((r) => [normalizeKey(r[0]), normalizeKey(r[1])])
        .filter(Boolean),
    );
    const unplaced = contacts.lines.filter(
      (l) =>
        !norm(l.values.contactType) &&
        !placed.has(normalizeKey(l.key)) &&
        !placed.has(normalizeKey(l.name)),
    );
    if (unplaced.length)
      warnings.push(
        `${unplaced.length} contact${unplaced.length === 1 ? '' : 's'} with nothing open (${unplaced
          .slice(0, 10)
          .map((l) => l.name ?? l.key)
          .join(
            ', ',
          )}${unplaced.length > 10 ? ', …' : ''}) ${unplaced.length === 1 ? 'is' : 'are'} not brought in: ${label}'s contact list does not say whether a contact is a customer or a supplier. Add ${unplaced.length === 1 ? 'it' : 'them'} in FinMatrix when needed.`,
      );
  }

  /** Credits net against the same party's oldest documents; what is left is returned. */
  const openDocs = (aged: ParsedSourceReport | undefined) => {
    const docs: Array<Array<string | null>> = [];
    const residual = new Map<string, Decimal>();
    const byParty = new Map<string, ReportLine[]>();
    for (const l of aged?.lines ?? [])
      byParty.set(l.key, [...(byParty.get(l.key) ?? []), l]);
    const seen = new Map<string, number>();
    for (const [party, lines] of byParty) {
      const open = lines
        .filter((l) => D(l.values.amount ?? 0).greaterThan(0))
        .sort((a, b) =>
          (a.values.date ?? '').localeCompare(b.values.date ?? ''),
        )
        .map((l) => ({ l, due: D(l.values.amount!) }));
      let credit = lines
        .filter((l) => D(l.values.amount ?? 0).lessThan(0))
        .reduce((t, l) => t.plus(D(l.values.amount!).abs()), D(0));
      for (const o of open) {
        if (credit.isZero()) break;
        const used = Decimal.min(credit, o.due);
        o.due = o.due.minus(used);
        credit = credit.minus(used);
      }
      if (credit.greaterThan(0)) residual.set(party, credit);
      for (const o of open) {
        if (o.due.isZero()) continue;
        const raw = o.l.values.doc ?? '';
        const k = normalizeKey(raw);
        const n = (seen.get(k) ?? 0) + 1;
        seen.set(k, n);
        const number =
          n > 1 ? `${raw}/${party}`.slice(0, 32) : raw.slice(0, 32);
        docs.push([
          party,
          number,
          o.l.values.date ?? opts.openingDate,
          o.l.values.due ?? null,
          money(o.l.values.original ?? o.l.values.amount!),
          money(o.due),
        ]);
      }
    }
    return { docs, residual };
  };
  const ar = openDocs(byKind.get('aged_receivables'));
  const ap = openDocs(byKind.get('aged_payables'));

  // Residual credits: held on an advances account only when accepted.
  const used = new Set([
    ...opts.existingAccounts,
    ...accountRows.map((r) => String(r[0])),
    ...tbRows.map((r) => String(r[0])),
  ]);
  const freshNumber = (start: number) => {
    let n = start;
    while (used.has(String(n))) n++;
    used.add(String(n));
    return String(n);
  };
  const holdResidual = (
    residual: Map<string, Decimal>,
    kind: 'customer' | 'vendor',
  ) => {
    if (!residual.size) return;
    const total = [...residual.values()].reduce((t, v) => t.plus(v), D(0));
    const key = kind === 'customer' ? 'customer-credits' : 'vendor-advances';
    const listed = [...residual]
      .slice(0, 10)
      .map(([p, v]) => `${p} ${money(v)}`)
      .join(', ');
    if (!opts.accepted(key)) {
      block(
        MIGRATION_CODES.SOURCE_NET_CREDIT,
        key,
        kind === 'customer'
          ? `${residual.size} customer${residual.size === 1 ? ' has' : 's have'} paid more than they owe in ${label} (${listed}): Rs ${money(total)} in all. FinMatrix will hold it on a Customer Advances account, to apply when they next buy. Accept, or settle the credits in ${label} and export again.`
          : `${residual.size} vendor${residual.size === 1 ? ' holds' : 's hold'} more of your money than you owe them in ${label} (${listed}): Rs ${money(total)} in all. FinMatrix will hold it on an Advances to Suppliers account. Accept, or settle it in ${label} and export again.`,
        null,
        [{ value: 'accept', label: 'Accept' }],
      );
      return;
    }
    // The control account in the TB already nets the credit; move it out.
    const control = [...kindOf.entries()].find(
      ([, k]) =>
        k.kind ===
        (kind === 'customer' ? 'Accounts Receivable' : 'Accounts Payable'),
    )?.[0];
    const row = tbRows.find((r) => r[0] === control);
    if (!row) return;
    const bal = D(row[2] ?? 0)
      .minus(row[3] ?? 0)
      .plus(kind === 'customer' ? total : total.negated());
    row[2] = bal.greaterThan(0) ? money(bal) : null;
    row[3] = bal.lessThan(0) ? money(bal.negated()) : null;
    const n = freshNumber(kind === 'customer' ? 2400 : 1400);
    const title =
      kind === 'customer'
        ? `Customer Advances (from ${label})`
        : `Advances to Suppliers (from ${label})`;
    accountRows.push([
      n,
      title,
      kind === 'customer' ? 'Liability' : 'Asset',
      kind === 'customer' ? 'Other Liability' : 'Other Asset',
      null,
    ]);
    tbRows.push([
      n,
      title,
      kind === 'customer' ? null : money(total),
      kind === 'customer' ? money(total) : null,
    ]);
    warnings.push(`${title}: Rs ${money(total)} — ${listed}.`);
  };
  holdResidual(ar.residual, 'customer');
  holdResidual(ap.residual, 'vendor');

  // ── Items and stock ──────────────────────────────────────────────────
  const valuation = byKind.get('inventory_valuation');
  const itemRows = new Map<string, Array<string | null>>();
  // An item's FinMatrix SKU: its own SKU column where it has one, else its ID or name.
  const itemCode = new Map<string, string>();
  const NOT_STOCK =
    /^(serv|service|othc|other charge|disc|discount|pmt|payment|grp|group|bundle|subt|subtotal|comptax|tax|salestax|sales tax item|category)$/i;
  for (const l of byKind.get('item_list')?.lines ?? []) {
    if (l.values.category && NOT_STOCK.test(l.values.category.trim())) continue;
    const code = (l.values.number ?? l.key).slice(0, 64);
    itemCode.set(l.key, code);
    itemRows.set(code, [
      code,
      l.name ?? l.key,
      l.values.category ?? null,
      l.values.unit ?? null,
      l.values.cost ?? null,
      l.values.price ?? null,
      null,
    ]);
  }
  const stockRows: Array<Array<string | null>> = [];
  for (const l of valuation?.lines ?? []) {
    const qty = D(l.values.qty ?? 0);
    const value = D(l.values.value ?? 0).toDecimalPlaces(2);
    if (qty.isZero() && value.isZero()) continue;
    if (!qty.greaterThan(0) || value.lessThan(0)) {
      block(
        MIGRATION_CODES.SOURCE_TOTALS_MISMATCH,
        `stock::${hash(l.key)}`,
        `${l.key}: ${label} values ${qty.toString()} on hand at Rs ${value.toFixed(2)}. FinMatrix cannot open with negative stock, or stock valued with none on hand. Correct it in ${label} and export the report again.`,
        valuation!.sheet,
      );
      continue;
    }
    const unitCost = value
      .dividedBy(qty)
      .toDecimalPlaces(4, Decimal.ROUND_HALF_UP)
      .toFixed(4);
    const code =
      itemCode.get(l.key) ??
      (l.values.number
        ? (itemCode.get(l.values.number) ?? l.values.number)
        : l.key);
    stockRows.push([code, qty.toString(), unitCost, value.toFixed(2)]);
    if (!itemRows.has(code)) {
      itemRows.set(code, [
        code,
        l.name ?? l.key,
        null,
        l.values.unit ?? null,
        unitCost,
        null,
        null,
      ]);
    }
  }
  const unpriced = [...itemRows.values()].filter((r) => !r[5]);
  if (unpriced.length)
    block(
      MIGRATION_CODES.SOURCE_REPORTS_MISSING,
      'item-prices',
      `${unpriced.length} item${unpriced.length === 1 ? ' has' : 's have'} no selling price (${unpriced
        .slice(0, 8)
        .map((r) => r[0])
        .join(
          ', ',
        )}${unpriced.length > 8 ? ', …' : ''}). Upload the Item List from ${label} — it carries the prices.`,
    );

  // Accounts without numbers get FinMatrix numbers: control accounts its
  // own, the rest by type. TB rows follow their account.
  const numbering = new Map<string, string>();
  const CONTROL_NUMBER: Record<string, string> = {
    ...DEFAULT_CONTROL_NUMBER,
    ...Object.fromEntries(
      Object.entries(opts.controlNumbers ?? {}).filter(
        (e): e is [string, string] => !!e[1],
      ),
    ),
  };
  const unnumbered = accountRows.filter((r) => !isNumber(String(r[0])));
  if (unnumbered.length) {
    const byControl = new Map<string, string[]>();
    for (const r of unnumbered) {
      const c = CONTROL_NUMBER[String(r[3])];
      if (c) byControl.set(c, [...(byControl.get(c) ?? []), String(r[0])]);
    }
    for (const [num, keys] of byControl)
      if (keys.length === 1) numbering.set(keys[0], num);
    const usedNumbers = new Set([
      ...accountRows
        .filter((r) => isNumber(String(r[0])))
        .map((r) => String(r[0])),
      ...opts.existingAccounts.filter(
        (n) => !Object.values(CONTROL_NUMBER).includes(n),
      ),
    ]);
    const next = new Map<string, number>();
    for (const r of unnumbered) {
      const k = String(r[0]);
      if (numbering.has(k)) continue;
      let n = next.get(String(r[2])) ?? NEW_ACCOUNT_BASE[String(r[2])] ?? 98001;
      while (usedNumbers.has(String(n))) n++;
      usedNumbers.add(String(n));
      next.set(String(r[2]), n + 1);
      numbering.set(k, String(n));
    }
    for (const r of accountRows)
      if (numbering.has(String(r[0]))) r[0] = numbering.get(String(r[0]))!;
    for (const r of tbRows)
      if (numbering.has(String(r[0]))) r[0] = numbering.get(String(r[0]))!;
    const strays = tbRows.filter((r) => !isNumber(String(r[0])));
    if (strays.length)
      block(
        MIGRATION_CODES.UNKNOWN_ACCOUNT,
        `tb-not-in-chart::${hash(strays.map((r) => r[0]).join('|'))}`,
        `The trial balance has accounts the chart of accounts does not list: ${strays
          .slice(0, 8)
          .map((r) => r[0])
          .join(
            ', ',
          )}${strays.length > 8 ? ', …' : ''}. Export both from ${label} at the same time.`,
      );
  }
  if (profile.partyCodes === false) {
    for (const r of [...customerRows, ...vendorRows]) r[0] = null;
  }

  if (accountRows.length)
    grids.push(grid(name('Accounts'), 'accounts', accountRows));
  if (customerRows.length)
    grids.push(grid(name('Customers'), 'customers', customerRows));
  if (vendorRows.length)
    grids.push(grid(name('Vendors'), 'vendors', vendorRows));
  if (itemRows.size)
    grids.push(grid(name('Items'), 'items', [...itemRows.values()]));
  if (tbRows.length)
    grids.push(grid(name('Trial Balance'), 'trial_balance', tbRows));
  if (ar.docs.length)
    grids.push(grid(name('Open Invoices'), 'open_invoices', ar.docs));
  if (ap.docs.length)
    grids.push(grid(name('Open Bills'), 'open_bills', ap.docs));
  if (stockRows.length) grids.push(grid(name('Stock'), 'stock', stockRows));
  return { grids, issues, warnings, proof };
}

/** The ISO date after `iso`. */
function dayAfter(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
