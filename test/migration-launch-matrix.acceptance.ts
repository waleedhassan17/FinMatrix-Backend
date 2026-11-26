/**
 * Migration Center — launch matrix (npm run test:migration-launch-matrix).
 *
 * The good path of every source is proven by test:migration-formats (each
 * reaches readiness 100, all eleven checks at Rs 0, TB balanced, A = L + E,
 * Migration Clearing 0, golden figures, undo). This suite adds what a launch
 * needs on top:
 *
 *   1. a FAULTY variant of every source — the same books with one figure
 *      changed — is blocked, with a plain-language reason the clients can
 *      show, and nothing reaches the books;
 *   2. a messy workbook with URDU-script headers, a merged title row and
 *      subtotal rows reads exactly like its English twin.
 *
 * In process, against the database in DB_* / DATABASE_URL (a scratch copy).
 */
import './migration-harness.env';
import * as ExcelJS from 'exceljs';
import AdmZip from 'adm-zip';
import {
  asUpload,
  bootHarness,
  freshCompany,
  type Harness,
} from './migration-harness';
import {
  sampleBooks,
  type SampleBooks,
} from '../scripts/migration-samples/books';
import {
  genericWorkbook,
  tallyFiles,
} from '../scripts/migration-samples/writers/basic';
import { quickbooksOnline } from '../scripts/migration-samples/writers/quickbooks';
import {
  xeroFiles,
  zohoFiles,
} from '../scripts/migration-samples/writers/xero-zoho';
import { MigrationIssue } from '../src/modules/migrations/entities/migration-issue.entity';

let pass = 0;
let fail = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 800) : ''}`,
    );
  }
};

/** Codes the web and app explain in plain English and Urdu. */
const CLIENT_CODES = new Set<string>();

async function loadClientCodes() {
  // The web map is the reference list the app mirrors.
  const fs = await import('fs');
  const p = `${__dirname}/../../../FinMatrix-Web/src/config/migrationErrors.ts`;
  if (!fs.existsSync(p)) return;
  const src = fs.readFileSync(p, 'utf8');
  for (const m of src.matchAll(/^\s+([A-Z][A-Z0-9_]+):\s/gm))
    CLIENT_CODES.add(m[1]);
}

interface Outcome {
  ready: boolean;
  readiness: number;
  reasons: Array<{ code: string; message: string }>;
  /** Blocking issue codes (the eleven checks carry their own labels). */
  issueCodes: string[];
  postedRows: number;
}

/** Analyse + validate a source's files on a fresh company. Never commits. */
async function attempt(
  h: Harness,
  b: SampleBooks,
  source: string,
  files: Array<{ name: string; buffer: Buffer }>,
): Promise<Outcome> {
  const { companyId, user } = await freshCompany(
    h.ds,
    `matrix-${source}-${Date.now()}`,
  );
  await h.ds.query(
    `UPDATE companies SET fiscal_year_start_month = $2 WHERE id = $1`,
    [companyId, b.fiscalYearStartMonth],
  );
  const batch = await h.svc.create(companyId, user, {
    sourceSystem: source,
    cutoverDate: b.cutoverDate,
  } as never);
  await h.svc.addFiles(
    companyId,
    user,
    batch.id,
    files.map((f) => asUpload(f.buffer, f.name)),
  );
  const issues = (
    await h.ds.manager.find(MigrationIssue, { where: { batchId: batch.id } })
  ).filter((i) => i.severity === 'blocking' && !i.resolvedAt);
  let readiness = 0;
  let status = 'mapped';
  let failedChecks: Array<{ code: string; message: string }> = [];
  if (!issues.length) {
    const v: any = await h.svc.validate(companyId, user, batch.id);
    readiness = v.readiness ?? 0;
    status = v.status;
    failedChecks = (v.checks ?? [])
      .filter((c: any) => !c.passed)
      .map((c: any) => ({
        code: c.code,
        message: `${c.label}: expected ${c.expected}, found ${c.actual}`,
      }));
  }
  const [posted] = await h.ds.query(
    `SELECT count(*)::int AS n FROM general_ledger WHERE company_id = $1`,
    [companyId],
  );
  return {
    ready: status === 'ready',
    readiness,
    reasons: [
      ...issues.map((i) => ({ code: i.code, message: i.message })),
      ...failedChecks,
    ],
    issueCodes: issues.map((i) => i.code),
    postedRows: posted.n,
  };
}

/** A cell's amount (number or lakh-style text), or null. */
function amountOf(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^(Rs\.?\s*)?[\d,]+(\.\d+)?$/.test(v.trim())) {
    return Number(v.replace(/[^\d.]/g, ''));
  }
  return null;
}

/**
 * Change the first non-zero figure under the trial balance's Debit column
 * (any sheet, any header row) by +delta. Falls back to the first figure on
 * the first sheet for single-sheet report exports.
 */
async function bumpXlsx(buffer: Buffer, delta: number): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  const done = async () => Buffer.from(await wb.xlsx.writeBuffer());
  for (const ws of wb.worksheets) {
    for (let r = 1; r <= Math.min(ws.rowCount, 15); r++) {
      const row = ws.getRow(r);
      let col = 0;
      row.eachCell((cell, c) => {
        if (!col && /^(debit|dr)$/i.test(String(cell.value ?? '').trim()))
          col = c;
      });
      if (!col) continue;
      for (let rr = r + 1; rr <= ws.rowCount; rr++) {
        const cell = ws.getRow(rr).getCell(col);
        const n = amountOf(cell.value);
        if (n) {
          cell.value =
            typeof cell.value === 'number' ? n + delta : String(n + delta);
          return done();
        }
      }
    }
  }
  const ws = wb.worksheets[0];
  for (let r = 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    for (let c = 2; c <= row.cellCount; c++) {
      const n = amountOf(row.getCell(c).value);
      if (n) {
        row.getCell(c).value =
          typeof row.getCell(c).value === 'number'
            ? n + delta
            : String(n + delta);
        return done();
      }
    }
  }
  throw new Error('no number to change');
}

function plainReason(o: Outcome): boolean {
  return (
    o.reasons.length > 0 &&
    o.reasons.every(
      (r) =>
        r.message.length > 15 &&
        !/\bat \w+ \(|QueryFailedError|undefined|NaN/.test(r.message),
    )
  );
}

async function main() {
  const t0 = Date.now();
  await loadClientCodes();
  const h = await bootHarness();
  const b = sampleBooks();
  try {
    const blocked = async (
      label: string,
      source: string,
      files: Array<{ name: string; buffer: Buffer }>,
    ) => {
      const o = await attempt(h, b, source, files);
      ok(
        `${label}: blocked with a plain-language reason, nothing posted`,
        !o.ready && plainReason(o) && o.postedRows === 0,
        o,
      );
      if (CLIENT_CODES.size) {
        const unknown = o.issueCodes.filter((c) => !CLIENT_CODES.has(c));
        ok(
          `${label}: every reason code has a client message`,
          unknown.length === 0,
          unknown,
        );
      }
      return o;
    };

    console.log('\n── 1. faulty variants');
    // Tally: one ledger's closing balance off by Rs 100 — the TB no longer balances.
    const tally = tallyFiles(b);
    const badTally = { ...tally };
    badTally['tally-trial-balance.xml'] = tally[
      'tally-trial-balance.xml'
    ].replace(
      /<DSPCLDRAMTA>-?(\d+)\.(\d\d)<\/DSPCLDRAMTA>/,
      (_m, whole: string, dec: string) =>
        `<DSPCLDRAMTA>-${Number(whole) + 100}.${dec}</DSPCLDRAMTA>`,
    );
    await blocked(
      'Tally XML with one ledger changed',
      'tally',
      Object.entries(badTally).map(([name, s]) => ({
        name,
        buffer: Buffer.from(s, 'utf8'),
      })),
    );

    // QuickBooks Online: the export ZIP's trial balance changed by Rs 100.
    const qbo = await quickbooksOnline(b);
    const qboZip = qbo['QuickBooks Online - Export data.zip'] as Buffer;
    const withZip = (zipBuffer: Buffer) =>
      Object.entries({
        ...qbo,
        'QuickBooks Online - Export data.zip': zipBuffer,
      }).map(([name, buffer]) => ({ name, buffer: buffer as Buffer }));
    const tampered = new AdmZip(qboZip);
    const tbName = tampered
      .getEntries()
      .find((e) => /trial[_ ]balance/i.test(e.entryName))!.entryName;
    tampered.updateFile(
      tbName,
      await bumpXlsx(tampered.readFile(tbName)!, 100),
    );
    await blocked(
      'QuickBooks Online export with the trial balance changed',
      'quickbooks_online',
      withZip(tampered.toBuffer()),
    );
    // …and its export ZIP missing the trial balance it needs.
    const missing = new AdmZip(qboZip);
    missing.deleteFile(tbName);
    await blocked(
      'QuickBooks Online export ZIP without its trial balance',
      'quickbooks_online',
      withZip(missing.toBuffer()),
    );

    // Xero / Zoho: the trial balance changed by Rs 100.
    for (const [label, source, make] of [
      ['Xero', 'xero', xeroFiles],
      ['Zoho Books', 'zoho_books', zohoFiles],
    ] as const) {
      const files: Record<string, Buffer | string> = await (
        make as (x: SampleBooks) => Promise<Record<string, Buffer | string>>
      )(b);
      const tb = files['Trial Balance.xlsx'] as Buffer;
      const bad = { ...files, 'Trial Balance.xlsx': await bumpXlsx(tb, 100) };
      await blocked(
        `${label} report export with the trial balance changed`,
        source,
        Object.entries(bad).map(([name, v]) => ({
          name,
          buffer: typeof v === 'string' ? Buffer.from(v, 'utf8') : v,
        })),
      );
    }

    // Generic spreadsheet: a trial balance that does not balance.
    const generic = await genericWorkbook(b);
    await blocked(
      'A spreadsheet whose trial balance is off by Rs 1',
      'generic_spreadsheet',
      [{ name: 'books.xlsx', buffer: await bumpXlsx(generic, 1) }],
    );

    console.log('\n── 2. messy Excel in Urdu');
    const urdu = await urduTwin(generic);
    const english = await attempt(h, b, 'generic_spreadsheet', [
      { name: 'books.xlsx', buffer: generic },
    ]);
    const inUrdu = await attempt(h, b, 'generic_spreadsheet', [
      { name: 'کھاتے.xlsx', buffer: urdu },
    ]);
    const codes = (o: Outcome) =>
      o.reasons
        .map((r) => r.code)
        .sort()
        .join(',');
    ok(
      'Urdu headers, a merged title row and subtotal rows read like the English twin',
      inUrdu.ready === english.ready &&
        inUrdu.readiness === english.readiness &&
        codes(inUrdu) === codes(english),
      {
        english: {
          ready: english.ready,
          readiness: english.readiness,
          codes: codes(english),
        },
        urdu: {
          ready: inUrdu.ready,
          readiness: inUrdu.readiness,
          codes: codes(inUrdu),
        },
      },
    );
  } finally {
    await h.close();
  }
  console.log(
    `\n${pass} passed, ${fail} failed in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  if (fail) {
    console.log('Failed:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

/**
 * The same workbook with Urdu column headers on the trial balance, a merged
 * title row on top, and a subtotal row ("کل") under the lines.
 */
async function urduTwin(buffer: Buffer): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  const urdu: Record<string, string> = {
    'account number': 'کھاتہ نمبر',
    'account no': 'کھاتہ نمبر',
    'a/c code': 'کھاتہ نمبر',
    code: 'کھاتہ نمبر',
    'account name': 'کھاتے کا نام',
    ledger: 'کھاتے کا نام',
    particulars: 'کھاتے کا نام',
    debit: 'ڈیبٹ',
    dr: 'ڈیبٹ',
    credit: 'کریڈٹ',
    cr: 'کریڈٹ',
  };
  for (const ws of wb.worksheets) {
    let headerRow = 0;
    ws.eachRow((row, r) => {
      if (headerRow) return;
      const cells = (row.values as unknown[]).slice(1).map((v) =>
        String(v ?? '')
          .trim()
          .toLowerCase(),
      );
      if (cells.some((c) => c === 'debit' || c === 'dr')) headerRow = r;
    });
    if (!headerRow) continue;
    const row = ws.getRow(headerRow);
    row.eachCell((cell) => {
      const k = String(cell.value ?? '')
        .trim()
        .toLowerCase();
      if (urdu[k]) cell.value = urdu[k];
    });
    ws.spliceRows(1, 0, ['میزان — 30 ستمبر 2026'], []);
    ws.mergeCells(1, 1, 1, 4);
    const last = ws.rowCount;
    ws.addRow(['', 'کل', '', '']);
    void last;
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
