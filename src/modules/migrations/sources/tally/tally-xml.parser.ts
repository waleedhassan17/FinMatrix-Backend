import { XMLParser } from 'fast-xml-parser';
import { SourceGrid } from '../../readers/read-upload';
import { TARGET_SHEETS } from '../../targets';
import {
  meaningOf,
  NEW_ACCOUNT_BASE,
  RESERVED_NUMBERS,
  TallyGroupMeaning,
} from './tally-groups';

/**
 * TallyPrime Data Interchange (XML) → the starter workbook's sheets.
 *
 * Four exports are understood, from one file each or all in one ZIP:
 *
 *   Masters (All Masters / List of Accounts, "Export → XML")
 *     ENVELOPE › BODY › IMPORTDATA › REQUESTDATA › TALLYMESSAGE ›
 *       GROUP@NAME (PARENT), LEDGER@NAME (PARENT, LEDGERPHONE, LEDGERMOBILE,
 *       EMAIL, ADDRESS.LIST, INCOMETAXNUMBER, CREDITLIMIT, BILLCREDITPERIOD),
 *       STOCKGROUP@NAME, STOCKITEM@NAME (PARENT, BASEUNITS, PARTNUMBER,
 *       OPENINGRATE, STANDARDPRICELIST.LIST › RATE)
 *   Trial Balance, ledger-wise ("Export" from Trial Balance with F5 ledger-wise)
 *     ENVELOPE › DSPACCNAME › DSPDISPNAME, then DSPACCINFO ›
 *       DSPCLDRAMT › DSPCLDRAMTA (debit, Tally writes it negative) and
 *       DSPCLCRAMT › DSPCLCRAMTA (credit)
 *   Bills Receivable / Bills Payable (bill-wise outstanding)
 *     ENVELOPE › BILLFIXED (BILLDATE, BILLREF, BILLPARTY), BILLCL, BILLDUE
 *   Stock Summary
 *     ENVELOPE › DSPACCNAME › DSPDISPNAME, then DSPSTKINFO › DSPSTKCL ›
 *       DSPCLQTY ("12 pcs"), DSPCLRATE ("8500.00/pcs"), DSPCLAMTA
 *
 * The output is the SAME grids an owner would type into the starter
 * workbook — headers included — so detection, mapping, matching, the nine
 * checks and the commit treat Tally exactly as they treat a spreadsheet.
 * Nothing here computes an amount: values are copied as Tally printed them
 * (absolute value, side from the column), and the deterministic parsers
 * downstream read them.
 *
 * Tally ledgers have names, not numbers. Its reserved ledgers take FinMatrix's
 * numbers (Cash 1000, Profit & Loss A/c 3100, the stock ledger 1200); a party
 * ledger's balance goes to the receivables (1100) or payables (2000) control
 * and the ledger itself becomes a customer or vendor; every other ledger gets
 * a stable five-digit number by type (assets 18001…, liabilities 28001…).
 */
export interface TallyBundle {
  grids: Array<SourceGrid & { fileIndex: number }>;
  warnings: string[];
  found: {
    masters: boolean;
    trialBalance: boolean;
    bills: boolean;
    stock: boolean;
  };
}

interface LedgerInfo {
  name: string;
  parent: string;
  meaning: TallyGroupMeaning | null;
  reserved: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  ntn: string | null;
  creditLimit: string | null;
  terms: string | null;
}

interface ItemInfo {
  name: string;
  sku: string;
  group: string | null;
  unit: string | null;
  rate: string | null;
  price: string | null;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  parseTagValue: false,
  trimValues: true,
  // Tally writes &#4; and similar control escapes into names.
  htmlEntities: true,
});

const asArray = <T>(v: T | T[] | undefined | null): T[] =>
  v === undefined || v === null ? [] : Array.isArray(v) ? v : [v];
const text = (v: unknown): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if ('#text' in o) return text(o['#text']);
    return null;
  }
  // eslint-disable-next-line no-control-regex
  const s = String(v)
    .replace(/[\u0000-\u001f]/g, '')
    .trim();
  return s === '' ? null : s;
};
const lc = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** "8500.00/pcs" → "8500.00"; "12 pcs" → "12"; "-150000.00" → "150000.00". */
export function tallyNumber(v: unknown, { abs = true } = {}): string | null {
  const s = text(v);
  if (!s) return null;
  const m = /-?\d[\d,]*(\.\d+)?/.exec(s);
  if (!m) return null;
  const n = m[0].replace(/,/g, '');
  return abs ? n.replace(/^-/, '') : n;
}

/** 20260415 → 2026-04-15; "15-Apr-2026" and "15-Apr-26" pass through for the date parser. */
export function tallyDate(v: unknown): string | null {
  const s = text(v);
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : s;
}

/** All elements named `tag` anywhere under `node`, depth-first, in document order. */
function collect(node: unknown, tag: string, out: unknown[] = []): unknown[] {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, tag, out);
    return out;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === tag) out.push(...asArray(v));
    if (v && typeof v === 'object') collect(v, tag, out);
  }
  return out;
}

/**
 * Tally reports are flat: DSPACCNAME is followed by its DSPACCINFO (or
 * DSPSTKINFO) as a sibling, and the XML parser groups siblings by name. The
 * pairs are rebuilt by position within each parent.
 */
function pairs(
  env: Record<string, unknown>,
  nameTag: string,
  infoTag: string,
): Array<{ name: string; info: Record<string, unknown> }> {
  const names = asArray(env[nameTag] as unknown[]);
  const infos = asArray(env[infoTag] as unknown[]);
  const out: Array<{ name: string; info: Record<string, unknown> }> = [];
  for (let i = 0; i < Math.min(names.length, infos.length); i++) {
    const n = text((names[i] as Record<string, unknown>)?.DSPDISPNAME);
    if (n)
      out.push({ name: n, info: (infos[i] ?? {}) as Record<string, unknown> });
  }
  return out;
}

export function parseTallyDocuments(
  docs: Array<{ xml: string; fileIndex: number }>,
): TallyBundle {
  const warnings: string[] = [];
  const found = {
    masters: false,
    trialBalance: false,
    bills: false,
    stock: false,
  };
  const groupParent = new Map<string, string>();
  const stockGroups = new Set<string>();
  const ledgers = new Map<string, LedgerInfo>();
  const items = new Map<string, ItemInfo>();
  const tbRows: Array<{
    name: string;
    debit: string | null;
    credit: string | null;
    file: number;
  }> = [];
  const bills: Array<{
    party: string;
    ref: string;
    date: string | null;
    due: string | null;
    amount: string;
    side: 'dr' | 'cr';
    file: number;
  }> = [];
  const stockRows: Array<{
    name: string;
    qty: string | null;
    rate: string | null;
    amount: string | null;
    file: number;
  }> = [];
  let mastersFile = -1;

  const parsed = docs.map((d) => {
    try {
      return { ...d, root: parser.parse(d.xml) as Record<string, unknown> };
    } catch (err) {
      warnings.push(
        `A Tally file could not be read as XML: ${(err as Error).message}`,
      );
      return { ...d, root: {} as Record<string, unknown> };
    }
  });

  // Masters first: they give every other report its meaning.
  for (const d of parsed) {
    const messages = collect(d.root, 'TALLYMESSAGE');
    if (!messages.length) continue;
    found.masters = true;
    if (mastersFile < 0) mastersFile = d.fileIndex;
    for (const g of collect(messages, 'GROUP') as Array<
      Record<string, unknown>
    >) {
      const name = text(g['@NAME']);
      if (name) groupParent.set(lc(name), text(g.PARENT) ?? '');
    }
    for (const g of collect(messages, 'STOCKGROUP') as Array<
      Record<string, unknown>
    >) {
      const name = text(g['@NAME']);
      if (name) stockGroups.add(lc(name));
    }
  }
  for (const d of parsed) {
    const messages = collect(d.root, 'TALLYMESSAGE');
    for (const l of collect(messages, 'LEDGER') as Array<
      Record<string, unknown>
    >) {
      const name = text(l['@NAME']);
      if (!name) continue;
      const parent = text(l.PARENT) ?? '';
      const reservedName = lc(text(l['@RESERVEDNAME']));
      const meaning = meaningOf(parent, groupParent);
      const address =
        collect(l['ADDRESS.LIST'], 'ADDRESS')
          .map(text)
          .filter(Boolean)
          .join(', ') || null;
      ledgers.set(lc(name), {
        name,
        parent,
        meaning,
        reserved:
          reservedName === 'profit & loss a/c' ||
          lc(name) === 'profit & loss a/c'
            ? RESERVED_NUMBERS.profitAndLoss
            : meaning?.role === 'cash' &&
                (reservedName === 'cash' || lc(name) === 'cash')
              ? RESERVED_NUMBERS.cash
              : meaning?.role === 'stock'
                ? RESERVED_NUMBERS.inventory
                : null,
        phone: text(l.LEDGERMOBILE) ?? text(l.LEDGERPHONE),
        email: text(l.EMAIL),
        address,
        ntn: text(l.INCOMETAXNUMBER),
        creditLimit: tallyNumber(l.CREDITLIMIT),
        terms: text(l.BILLCREDITPERIOD),
      });
    }
    for (const s of collect(messages, 'STOCKITEM') as Array<
      Record<string, unknown>
    >) {
      const name = text(s['@NAME']);
      if (!name) continue;
      const price =
        collect(s['STANDARDPRICELIST.LIST'], 'RATE')
          .map((r) => tallyNumber(r))
          .find(Boolean) ??
        collect(s['FULLPRICELIST.LIST'], 'RATE')
          .map((r) => tallyNumber(r))
          .find(Boolean) ??
        null;
      items.set(lc(name), {
        name,
        sku: (
          text(s.PARTNUMBER) ??
          text(collect(s['NAME.LIST'], 'NAME')[1]) ??
          name
        ).slice(0, 64),
        group: text(s.PARENT),
        unit: text(s.BASEUNITS),
        rate: tallyNumber(s.OPENINGRATE),
        price,
      });
    }
  }

  // Reports.
  for (const d of parsed) {
    for (const env of collect(d.root, 'ENVELOPE').concat(
      d.root.ENVELOPE ? [] : [d.root],
    ) as Array<Record<string, unknown>>) {
      if (env.DSPACCINFO) {
        found.trialBalance = true;
        for (const p of pairs(env, 'DSPACCNAME', 'DSPACCINFO')) {
          const dr = tallyNumber(
            (p.info.DSPCLDRAMT as Record<string, unknown>)?.DSPCLDRAMTA,
          );
          const cr = tallyNumber(
            (p.info.DSPCLCRAMT as Record<string, unknown>)?.DSPCLCRAMTA,
          );
          tbRows.push({
            name: p.name,
            debit: dr && Number(dr) !== 0 ? dr : null,
            credit: cr && Number(cr) !== 0 ? cr : null,
            file: d.fileIndex,
          });
        }
      }
      if (env.DSPSTKINFO) {
        found.stock = true;
        for (const p of pairs(env, 'DSPACCNAME', 'DSPSTKINFO')) {
          const cl = (p.info.DSPSTKCL ?? {}) as Record<string, unknown>;
          stockRows.push({
            name: p.name,
            qty: tallyNumber(cl.DSPCLQTY),
            rate: tallyNumber(cl.DSPCLRATE),
            amount: tallyNumber(cl.DSPCLAMTA),
            file: d.fileIndex,
          });
        }
      }
      if (env.BILLFIXED) {
        found.bills = true;
        const fixed = asArray(env.BILLFIXED as unknown[]);
        const cl = asArray(env.BILLCL as unknown[]);
        const due = asArray(env.BILLDUE as unknown[]);
        fixed.forEach((f, i) => {
          const fx = f as Record<string, unknown>;
          const party = text(fx.BILLPARTY);
          const ref = text(fx.BILLREF);
          const signed = tallyNumber(cl[i], { abs: false });
          if (!party || !ref || !signed) return;
          bills.push({
            party,
            ref,
            date: tallyDate(fx.BILLDATE),
            due: tallyDate(due[i]),
            amount: signed.replace(/^-/, ''),
            side: signed.startsWith('-') ? 'dr' : 'cr',
            file: d.fileIndex,
          });
        });
      }
    }
  }

  // Masters may be missing; say what that costs instead of guessing.
  if (!found.masters && (found.trialBalance || found.bills)) {
    warnings.push(
      'No Tally masters export was found, so ledgers cannot be told apart (customer, vendor, bank, expense…). Export "All Masters" from Tally and add it to this migration.',
    );
  }

  // ── Numbers for ledgers ─────────────────────────────────────────────
  const numberOf = new Map<string, string>();
  const next: Record<string, number> = { ...NEW_ACCOUNT_BASE };
  const accounts: Array<Array<string | null>> = [];
  for (const l of [...ledgers.values()].sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    // Profit & Loss A/c is a primary ledger with no group: earlier years' profit.
    if (l.reserved === RESERVED_NUMBERS.profitAndLoss) {
      numberOf.set(lc(l.name), RESERVED_NUMBERS.profitAndLoss);
      accounts.push([
        RESERVED_NUMBERS.profitAndLoss,
        l.name,
        'Equity',
        'Retained Earnings',
        null,
      ]);
      continue;
    }
    if (!l.meaning) {
      warnings.push(
        `Ledger "${l.name}" is under "${l.parent}", which is not a Tally group we recognise.`,
      );
      continue;
    }
    if (l.meaning.role === 'customer') {
      numberOf.set(lc(l.name), RESERVED_NUMBERS.receivables);
      continue;
    }
    if (l.meaning.role === 'vendor') {
      numberOf.set(lc(l.name), RESERVED_NUMBERS.payables);
      continue;
    }
    const number = l.reserved ?? String(next[l.meaning.type]++);
    numberOf.set(lc(l.name), number);
    accounts.push([number, l.name, cap(l.meaning.type), l.meaning.kind, null]);
  }
  // The stock ledger often appears in reports as "Closing Stock" with no master.
  if (!numberOf.has('closing stock'))
    numberOf.set('closing stock', RESERVED_NUMBERS.inventory);

  const header = (key: string) =>
    TARGET_SHEETS.find((t) => t.key === key)!.fields.map((f) => f.header);
  const grid = (
    name: string,
    key: string,
    rows: Array<Array<string | null>>,
    fileIndex: number,
  ): SourceGrid & { fileIndex: number } => ({
    name,
    fileIndex,
    rows: [
      { rowNumber: 1, cells: header(key) },
      ...rows.map((cells, i) => ({ rowNumber: i + 2, cells })),
    ],
  });
  const out: TallyBundle['grids'] = [];
  const f = (n: number) => (n >= 0 ? n : 0);

  if (found.masters) {
    out.push(grid('Accounts (Tally)', 'accounts', accounts, f(mastersFile)));
    const parties = (role: 'customer' | 'vendor') =>
      [...ledgers.values()]
        .filter((l) => l.meaning?.role === role)
        .sort((a, b) => a.name.localeCompare(b.name));
    out.push(
      grid(
        'Customers (Tally)',
        'customers',
        parties('customer').map((l) => [
          null,
          l.name,
          l.phone,
          l.email,
          l.address,
          null,
          l.terms,
          l.creditLimit,
          l.ntn,
        ]),
        f(mastersFile),
      ),
    );
    out.push(
      grid(
        'Vendors (Tally)',
        'vendors',
        parties('vendor').map((l) => [
          null,
          l.name,
          l.phone,
          l.email,
          l.address,
          null,
          l.terms,
          l.ntn,
        ]),
        f(mastersFile),
      ),
    );
    if (items.size) {
      out.push(
        grid(
          'Items (Tally)',
          'items',
          [...items.values()].map((i) => [
            i.sku,
            i.name,
            i.group,
            i.unit,
            i.rate ?? '0',
            i.price ?? '0',
            null,
          ]),
          f(mastersFile),
        ),
      );
    }
  }
  if (found.trialBalance) {
    const rows: Array<Array<string | null>> = [];
    for (const r of tbRows) {
      const key = lc(r.name);
      if (groupParent.has(key) && !ledgers.has(key)) continue; // a group subtotal, not a ledger
      if (key === 'grand total' || key === 'total') continue;
      rows.push([numberOf.get(key) ?? r.name, r.name, r.debit, r.credit]);
    }
    out.push(
      grid(
        'Trial Balance (Tally)',
        'trial_balance',
        rows,
        tbRows[0]?.file ?? 0,
      ),
    );
  }
  if (found.bills) {
    const party = (b: (typeof bills)[number]) =>
      ledgers.get(lc(b.party))?.meaning?.role ??
      (b.side === 'dr' ? 'customer' : 'vendor');
    // Tally's outstanding report carries the PENDING amount only, so the original equals it.
    const inv = bills
      .filter((b) => party(b) === 'customer')
      .map((b) => [b.party, b.ref, b.date, b.due, b.amount, b.amount]);
    const bil = bills
      .filter((b) => party(b) === 'vendor')
      .map((b) => [b.party, b.ref, b.date, b.due, b.amount, b.amount]);
    if (inv.length)
      out.push(
        grid('Open Invoices (Tally)', 'open_invoices', inv, bills[0].file),
      );
    if (bil.length)
      out.push(grid('Open Bills (Tally)', 'open_bills', bil, bills[0].file));
  }
  if (found.stock) {
    const rows: Array<Array<string | null>> = [];
    for (const s of stockRows) {
      const key = lc(s.name);
      if (stockGroups.has(key) && !items.has(key)) continue; // a stock group subtotal
      if (key === 'grand total' || key === 'total') continue;
      const item = items.get(key);
      rows.push([item?.sku ?? s.name, s.qty, s.rate ?? null]);
    }
    out.push(grid('Stock (Tally)', 'stock', rows, stockRows[0]?.file ?? 0));
  }
  return { grids: out, warnings, found };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
