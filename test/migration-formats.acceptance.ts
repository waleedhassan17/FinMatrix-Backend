/**
 * Migration Center — the same invented books in every format must come out
 * the same in FinMatrix. In process, against the dev database.
 *
 *   npx ts-node -r tsconfig-paths/register test/migration-formats.acceptance.ts [folder…]
 *
 * For each sample folder (scripts/migration-samples): a fresh company, the
 * folder's files, the owner's expected confirmations, then all eleven checks,
 * Import, and the books compared with the golden figures (trial balance,
 * receivables, payables, stock, retained earnings, profit to date); then Undo.
 * Any issue the owner would have to resolve that is not an expected
 * confirmation fails the folder, with its message.
 */
import './migration-harness.env';
import AdmZip from 'adm-zip';
import Decimal from 'decimal.js';
import { bootHarness, freshCompany, Harness } from './migration-harness';
import { MigrationIssue } from '../src/modules/migrations/entities/migration-issue.entity';
import { MigrationUploadsService } from '../src/modules/migrations/uploads/migration-uploads.service';
import { MigrationReadWorker } from '../src/modules/migrations/uploads/migration-read.worker';
import { existsSync } from 'fs';
import { open as openFile } from 'fs/promises';
import { basename, join } from 'path';
import { homedir } from 'os';
import {
  expectedResults,
  SampleBooks,
  sampleBooks,
} from '../scripts/migration-samples/books';
import {
  genericWorkbook,
  peachtreeReports,
  starterWorkbook,
  tallyFiles,
} from '../scripts/migration-samples/writers/basic';
import {
  quickbooksDesktop,
  quickbooksOnline,
} from '../scripts/migration-samples/writers/quickbooks';
import {
  xeroFiles,
  zohoFiles,
} from '../scripts/migration-samples/writers/xero-zoho';

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
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 1200) : ''}`,
    );
  }
};
const upload = (buffer: Buffer, name: string) => ({
  buffer,
  originalname: name,
  mimetype: 'application/octet-stream',
  size: buffer.length,
});

interface Case {
  folder: string;
  source: string;
  files: () => Promise<Array<{ name: string; buffer: Buffer }>>;
  /** Account numbers differ from the source's (Tally has none). */
  numbersDiffer?: boolean;
  /** The source's own printed totals are compared (SOURCE_REPORTS_MATCH applies). */
  proven?: boolean;
  /** A file sent through the large-upload route first (path on disk). */
  large?: string;
  /** Parties brought in, where the source cannot place every contact (Xero). */
  parties?: { customers: number; vendors: number };
  /** Set the company up before the migration starts. */
  prepare?: (h: Harness, companyId: string) => Promise<void>;
  /** More to check once imported. */
  after?: (h: Harness, companyId: string) => Promise<void>;
}

/**
 * The same books under other account numbers (old → new), as another
 * system would number them. Totals are unchanged.
 */
function renumbered(
  b: SampleBooks,
  moves: Record<string, string>,
  names: Record<string, string> = {},
): SampleBooks {
  const to = (n: string) => moves[n] ?? n;
  return {
    ...b,
    accounts: b.accounts.map((a) => ({
      ...a,
      number: to(a.number),
      name: names[a.number] ?? a.name,
    })),
    balances: new Map([...b.balances].map(([n, v]) => [to(n), v])),
  };
}

async function runCase(h: Harness, b: SampleBooks, c: Case) {
  console.log(`\n── ${c.folder}`);
  const { companyId, user } = await freshCompany(
    h.ds,
    `formats-${c.folder}-${Date.now()}`,
  );
  await h.ds.query(
    `UPDATE companies SET fiscal_year_start_month = $2 WHERE id = $1`,
    [companyId, b.fiscalYearStartMonth],
  );
  if (c.prepare) await c.prepare(h, companyId);
  const batch = await h.svc.create(companyId, user, {
    sourceSystem: c.source,
    cutoverDate: b.cutoverDate,
  } as any);
  if (c.large) {
    const uploads = h.app.get(MigrationUploadsService);
    const worker = h.app.get(MigrationReadWorker);
    const fh = await openFile(c.large, 'r');
    const { size } = await fh.stat();
    const t0 = Date.now();
    const up = await uploads.start(companyId, user, batch.id, {
      name: basename(c.large),
      size,
    });
    for (let n = 0; n < up.parts; n++) {
      const len = Math.min(up.partSize, size - n * up.partSize);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, n * up.partSize);
      await uploads.putPart(companyId, batch.id, up.id, n, buf);
    }
    await fh.close();
    await uploads.complete(companyId, batch.id, up.id);
    const t1 = Date.now();
    const rss0 = process.memoryUsage().rss;
    await worker.runOnce();
    const st = await uploads.status(companyId, batch.id, up.id);
    console.log(
      `     ${(size / 1_048_576).toFixed(0)} MB: sent in ${((t1 - t0) / 1000).toFixed(1)} s, read in ${((Date.now() - t1) / 1000).toFixed(1)} s; RSS ${Math.round(rss0 / 1e6)} → ${Math.round(process.memoryUsage().rss / 1e6)} MB, peak ${Math.round(process.resourceUsage().maxRSS / 1024)} MB`,
    );
    ok(`${c.folder}: the large export was read`, st.status === 'read', st);
    const f = (await h.svc.get(companyId, batch.id)).files?.find(
      (x: any) => x.kind === 'extract',
    );
    const targets = (f?.detected ?? []).map((d: any) => d.target);
    ok(
      `${c.folder}: its trial balance and lists were kept`,
      [
        'quickbooks_online:trial_balance',
        'quickbooks_online:customer_list',
        'quickbooks_online:vendor_list',
      ].every((t) => targets.includes(t)),
      targets,
    );
  }
  const files = await c.files();
  await h.svc.addFiles(
    companyId,
    user,
    batch.id,
    files.map((f) => upload(f.buffer, f.name)),
  );
  const issues = () =>
    h.ds.manager.find(MigrationIssue, { where: { batchId: batch.id } });

  // The owner confirms what FinMatrix proposes (sheets, columns, accounts).
  for (let round = 0; round < 3; round++) {
    const maps = await h.svc.getMappings(companyId, batch.id);
    const review = [
      ...maps.mappings.sheet,
      ...maps.mappings.column,
      ...maps.mappings.account,
    ].filter((m: any) => m.needsReview && m.target);
    if (!review.length) break;
    console.log(
      `     confirmed ${review.length} proposal(s): ${review
        .map((m: any) => `${m.kind} ${m.source}→${m.target}`)
        .join('; ')
        .slice(0, 300)}`,
    );
    await h.svc.patchMappings(
      companyId,
      user,
      batch.id,
      review.map((m: any) => ({
        kind: m.kind,
        sheet: m.sheet ?? undefined,
        source: m.source,
        target: m.target,
      })),
    );
  }
  const open = (await issues()).filter((i) => !i.resolution);
  const blocking = open.filter((i) => i.severity === 'blocking');
  const warnings = open.filter((i) => i.severity === 'warning');
  if (warnings.length)
    console.log(
      `     warnings: ${warnings.map((i) => `${i.code}: ${i.message.slice(0, 120)}`).join(' | ')}`,
    );
  ok(
    `${c.folder}: nothing left for the owner to fix`,
    blocking.length === 0,
    blocking.map(
      (i) =>
        `${i.code} ${i.sheet ?? ''}#${i.rowNumber ?? ''}: ${i.message.slice(0, 200)}`,
    ),
  );
  if (blocking.length) return;

  const v = await h.svc.validate(companyId, user, batch.id);
  const failed = (v.checks ?? []).filter((x: any) => !x.passed);
  ok(
    `${c.folder}: all eleven checks pass`,
    (v.checks ?? []).length === 11 && failed.length === 0,
    failed.map(
      (x: any) =>
        `${x.code} ${x.expected} ${x.actual} ${JSON.stringify(x.details).slice(0, 300)}`,
    ),
  );
  ok(
    `${c.folder}: ready to import (100%)`,
    v.status === 'ready' && v.readiness === 100,
    { status: v.status, readiness: v.readiness },
  );
  if (c.proven) {
    const proof = (v.checks ?? []).find(
      (x: any) => x.code === 'SOURCE_REPORTS_MATCH',
    );
    ok(
      `${c.folder}: every total the reports print was compared (${proof?.expected} → ${proof?.actual})`,
      !!proof &&
        proof.passed &&
        /^\d+ lines$/.test(proof.expected) &&
        proof.expected !== '0 lines',
      proof,
    );
  }
  if (v.status !== 'ready') return;
  await h.svc.signOff(companyId, user, batch.id, {
    confirmed: true,
    spotCheckDone: true,
  });
  await h.svc.commit(companyId, user, batch.id);

  const e = expectedResults(b);
  const tb = await h.reports.trialBalance(
    companyId,
    '1970-01-01',
    '2999-12-31',
  );
  ok(
    `${c.folder}: trial balance = Rs ${e.trialBalanceTotal}`,
    tb.isBalanced && new Decimal(tb.totalDebits).equals(e.trialBalanceTotal),
    { dr: tb.totalDebits, cr: tb.totalCredits },
  );
  const one = async (sql: string) =>
    new Decimal((await h.ds.query(sql, [companyId]))[0].v ?? 0);
  const ar = await one(
    `SELECT COALESCE(SUM(balance),0)::text AS v FROM invoices WHERE company_id = $1`,
  );
  ok(
    `${c.folder}: receivables = Rs ${e.receivables}`,
    ar.equals(e.receivables),
    ar.toFixed(2),
  );
  const ap = await one(
    `SELECT COALESCE(SUM(balance),0)::text AS v FROM bills WHERE company_id = $1`,
  );
  ok(
    `${c.folder}: payables = Rs ${e.payables}`,
    ap.equals(e.payables),
    ap.toFixed(2),
  );
  const stock = await one(
    `SELECT COALESCE(SUM(value_change),0)::text AS v FROM inventory_movements WHERE company_id = $1 AND source_type = 'migration'`,
  );
  ok(
    `${c.folder}: stock = Rs ${e.inventory}`,
    stock.equals(e.inventory),
    stock.toFixed(2),
  );
  const counts = await h.ds.query(
    `SELECT (SELECT count(*) FROM customers WHERE company_id = $1)::int AS c, (SELECT count(*) FROM vendors WHERE company_id = $1)::int AS v,
            (SELECT count(*) FROM inventory_items WHERE company_id = $1)::int AS i`,
    [companyId],
  );
  const wantC = c.parties?.customers ?? e.customers;
  const wantV = c.parties?.vendors ?? e.vendors;
  ok(
    `${c.folder}: ${wantC} customers, ${wantV} vendors, ${e.items} items`,
    counts[0].c === wantC && counts[0].v === wantV && counts[0].i === e.items,
    counts[0],
  );
  const pnl = await h.reports.profitLoss(
    companyId,
    '2026-07-01',
    b.openingDate,
  );
  ok(
    `${c.folder}: profit July–September = Rs ${e.profitYearToDate}`,
    new Decimal(pnl.netIncome).toDecimalPlaces(2).equals(e.profitYearToDate),
    pnl.netIncome,
  );
  const bs = await h.reports.balanceSheet(companyId, b.cutoverDate);
  const re = bs.equity.find(
    (l: any) =>
      /retained/i.test(l.accountName ?? l.name ?? '') ||
      l.accountCode === '3100',
  );
  ok(
    `${c.folder}: retained earnings = Rs ${e.retainedEarnings}`,
    !!re && new Decimal(re.amount).equals(e.retainedEarnings),
    re,
  );
  if (!c.numbersDiffer) {
    // The owner's chart wins: every account they had a balance on is in
    // FinMatrix under its own number, never renumbered.
    const chart = new Set(
      (
        await h.ds.query(
          `SELECT account_number FROM accounts WHERE company_id = $1 AND is_active`,
          [companyId],
        )
      ).map((r: any) => r.account_number),
    );
    const lost = b.accounts
      .filter(
        (a) =>
          !new Decimal(b.balances.get(a.number) ?? 0).isZero() &&
          !chart.has(a.number),
      )
      .map((a) => `${a.number} ${a.name}`);
    ok(
      `${c.folder}: every account keeps the owner's number`,
      lost.length === 0,
      lost,
    );
  }
  if (c.after) await c.after(h, companyId);

  await h.svc.rollback(companyId, user, batch.id);
  const after = await h.reports.trialBalance(
    companyId,
    '1970-01-01',
    '2999-12-31',
  );
  ok(
    `${c.folder}: undo empties the books`,
    after.rows.length === 0,
    after.rows.length,
  );
}

/** A report changed one way must be refused, saying why. */
async function mutation(
  h: Harness,
  b: SampleBooks,
  name: string,
  source: string,
  files: Array<{ name: string; buffer: Buffer }>,
  code: string,
  match: RegExp,
) {
  const { companyId, user } = await freshCompany(
    h.ds,
    `mutation-${Date.now()}`,
  );
  await h.ds.query(
    `UPDATE companies SET fiscal_year_start_month = $2 WHERE id = $1`,
    [companyId, b.fiscalYearStartMonth],
  );
  const batch = await h.svc.create(companyId, user, {
    sourceSystem: source,
    cutoverDate: b.cutoverDate,
  } as any);
  await h.svc.addFiles(
    companyId,
    user,
    batch.id,
    files.map((f) => upload(f.buffer, f.name)),
  );
  const found = (
    await h.ds.manager.find(MigrationIssue, { where: { batchId: batch.id } })
  ).filter((i) => i.code === code && i.severity === 'blocking');
  ok(
    name,
    found.some((i) => match.test(i.message)),
    found.map((i) => i.message).concat(found.length ? [] : ['no such issue']),
  );
}

async function editSheet(
  buffer: Buffer,
  edit: (ws: import('exceljs').Worksheet) => void,
): Promise<Buffer> {
  const ExcelJS = await import('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as any);
  edit(wb.worksheets[0]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function main() {
  const b = sampleBooks();
  const tally = tallyFiles(b);
  /** The clash case's final chart, to compare its run on a chart without roles. */
  let clashChart: unknown[] | null = null;
  const cases: Case[] = [
    {
      folder: '01-starter',
      source: 'finmatrix_template',
      files: async () => [
        { name: 'Starter Workbook.xlsx', buffer: await starterWorkbook(b) },
      ],
    },
    {
      folder: '04-tally',
      source: 'tally',
      numbersDiffer: true,
      files: async () =>
        Object.entries(tally).map(([name, s]) => ({
          name,
          buffer: Buffer.from(s, 'utf8'),
        })),
    },
    {
      folder: '04-tally (one ZIP)',
      source: 'tally',
      numbersDiffer: true,
      files: async () => {
        const z = new AdmZip();
        for (const [n, s] of Object.entries(tally))
          z.addFile(n, Buffer.from(s, 'utf8'));
        return [{ name: 'tally-export.zip', buffer: z.toBuffer() }];
      },
    },
    {
      folder: '03-peachtree-reports-only',
      source: 'peachtree',
      proven: true,
      files: async () =>
        Object.entries(await peachtreeReports(b)).map(([name, buffer]) => ({
          name,
          buffer,
        })),
    },
    {
      folder: '05-quickbooks-online',
      source: 'quickbooks_online',
      proven: true,
      numbersDiffer: true,
      files: async () =>
        Object.entries(await quickbooksOnline(b)).map(([name, buffer]) => ({
          name,
          buffer,
        })),
    },
    {
      // A source without numbers lands on FinMatrix's accounts where they are
      // now — here Receivables already moved to 11000 — never back on 1100.
      folder: '05-quickbooks-online (receivables already at 11000)',
      source: 'quickbooks_online',
      proven: true,
      numbersDiffer: true,
      prepare: async (h: Harness, companyId: string) => {
        await h.ds.query(
          `UPDATE accounts SET account_number = '11000' WHERE company_id = $1 AND system_role = 'accounts_receivable'`,
          [companyId],
        );
      },
      after: async (h: Harness, companyId: string) => {
        const [ar] = await h.ds.query(
          `SELECT account_number AS number, balance::text AS balance FROM accounts WHERE company_id = $1 AND system_role = 'accounts_receivable'`,
          [companyId],
        );
        ok(
          'unnumbered source: Receivables stays at 11000 and holds the receivables',
          ar?.number === '11000' &&
            new Decimal(ar.balance).equals(b.balances.get('1100')!),
          ar,
        );
        const [stray] = await h.ds.query(
          `SELECT count(*)::int AS n FROM accounts WHERE company_id = $1 AND account_number = '1100'`,
          [companyId],
        );
        ok(
          'unnumbered source: no second receivables account at 1100',
          stray.n === 0,
          stray,
        );
      },
      files: async () =>
        Object.entries(await quickbooksOnline(b)).map(([name, buffer]) => ({
          name,
          buffer,
        })),
    },
    {
      folder: '06-quickbooks-desktop',
      source: 'quickbooks_desktop',
      proven: true,
      files: async () =>
        Object.entries(await quickbooksDesktop(b)).map(([name, v]) => ({
          name,
          buffer: Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8'),
        })),
    },
    ...(existsSync(
      join(
        homedir(),
        'FinMatrix-Migration-Samples/90-large/QuickBooks Online - Export data (large).zip',
      ),
    )
      ? [
          {
            folder: '90-large',
            source: 'quickbooks_online',
            proven: true,
            // QuickBooks Online has no account numbers: FinMatrix numbers them.
            numbersDiffer: true,
            large: join(
              homedir(),
              'FinMatrix-Migration-Samples/90-large/QuickBooks Online - Export data (large).zip',
            ),
            files: async () =>
              Object.entries(await quickbooksOnline(b))
                .filter(([n]) => !n.endsWith('.zip'))
                .map(([name, buffer]) => ({ name, buffer })),
          },
        ]
      : []),
    {
      folder: '07-xero',
      source: 'xero',
      proven: true,
      // Xero's contact list does not mark customers and suppliers: the two
      // with nothing open are named in a warning, not guessed.
      parties: {
        customers: b.customers.length - 1,
        vendors: b.vendors.length - 1,
      },
      files: async () =>
        Object.entries(await xeroFiles(b)).map(([name, v]) => ({
          name,
          buffer: Buffer.isBuffer(v) ? v : Buffer.from(v, 'utf8'),
        })),
    },
    {
      folder: '08-zoho-books',
      source: 'zoho_books',
      proven: true,
      files: async () =>
        Object.entries(await zohoFiles(b)).map(([name, buffer]) => ({
          name,
          buffer,
        })),
    },
    {
      folder: '15-generic-excel',
      source: 'generic_spreadsheet',
      files: async () => [
        { name: 'Books.xlsx', buffer: await genericWorkbook(b) },
      ],
    },
    ...[false, true].map((legacy): Case => {
      // Sage 50 UK numbering: the bank at 1200 (FinMatrix's Inventory), stock
      // at 1001, and rent at 6200 (FinMatrix's Salary Expense). Each must be
      // its own account, never merged by number.
      //
      // Run twice: the second time on a chart written by the release from
      // before system roles (a company it created while this one rolled out),
      // which the analysis must give its roles back first.
      const sage = renumbered(
        b,
        { '1050': '1200', '1200': '1001', '6060': '6200' },
        { '1050': 'Bank Current Account', '1200': 'Stock' },
      );
      return {
        folder: legacy
          ? 'clash-sage-numbering (a chart written before roles)'
          : 'clash-sage-numbering',
        source: 'finmatrix_template',
        prepare: legacy
          ? async (h: Harness, companyId: string) => {
              await h.ds.query(
                `UPDATE accounts SET system_role = NULL WHERE company_id = $1`,
                [companyId],
              );
            }
          : undefined,
        // Its own numbering: checked account by account below.
        numbersDiffer: true,
        files: async () => [
          {
            name: 'Starter Workbook.xlsx',
            buffer: await starterWorkbook(sage),
          },
        ],
        after: async (h: Harness, companyId: string) => {
          const role = async (r: string) =>
            (
              await h.ds.query(
                `SELECT account_number AS number, name, balance::text AS balance FROM accounts WHERE company_id = $1 AND system_role = $2`,
                [companyId, r],
              )
            )[0] as
              | { number: string; name: string; balance: string }
              | undefined;
          const byNumber = async (n: string) =>
            (
              await h.ds.query(
                `SELECT name, system_role AS role, balance::text AS balance FROM accounts WHERE company_id = $1 AND account_number = $2`,
                [companyId, n],
              )
            )[0] as
              | { name: string; role: string | null; balance: string }
              | undefined;
          const inv = await role('inventory');
          ok(
            'clash: FinMatrix Inventory became the owner’s 1001 Stock, holding the stock',
            inv?.number === '1001' &&
              inv.name === 'Stock' &&
              new Decimal(inv.balance).equals(b.balances.get('1200')!),
            inv,
          );
          const bank = await role('bank');
          ok(
            'clash: FinMatrix’s bank became the owner’s 1200 Bank Current Account',
            bank?.number === '1200' &&
              bank.name === 'Bank Current Account' &&
              new Decimal(bank.balance).equals(b.balances.get('1050')!),
            bank,
          );
          const salary = await role('salary_expense');
          ok(
            'clash: Salary Expense took the owner’s 6050 Salaries & Wages',
            salary?.number === '6050' && salary.name === 'Salaries & Wages',
            salary,
          );
          const rent = await byNumber('6200');
          ok(
            'clash: the owner’s 6200 Warehouse Rent was created with its own number',
            rent?.name === 'Warehouse Rent' &&
              !rent.role &&
              new Decimal(rent.balance).equals(b.balances.get('6060')!),
            rent,
          );
          // Every owner account is in the chart under its own number and name.
          const missing: string[] = [];
          for (const a of sage.accounts) {
            const got = await byNumber(a.number);
            if (!got || got.name !== a.name)
              missing.push(`${a.number} ${a.name} → ${got?.name ?? 'missing'}`);
          }
          ok(
            'clash: every owner account kept its number and name',
            missing.length === 0,
            missing,
          );

          // Automatic posting follows the role: a new invoice after the
          // migration lands in the owner's accounts.
          const { InvoicesService } =
            await import('../src/modules/invoices/invoices.service');
          const item = (
            await h.ds.query(
              `SELECT id FROM inventory_items WHERE company_id = $1 AND quantity_on_hand > 0 ORDER BY sku LIMIT 1`,
              [companyId],
            )
          )[0];
          const customer = (
            await h.ds.query(
              `SELECT id FROM customers WHERE company_id = $1 ORDER BY code LIMIT 1`,
              [companyId],
            )
          )[0];
          const user = (
            await h.ds.query(
              `SELECT created_by AS id FROM companies WHERE id = $1`,
              [companyId],
            )
          )[0];
          // Inside a transaction rolled back afterwards, so undo still applies.
          let hit: Array<{ number: string; role: string | null }> = [];
          await h.ds
            .transaction(async (m) => {
              const invoice = await h.app
                .get(InvoicesService)
                .createInTransaction(m, companyId, user.id, {
                  customerId: customer.id,
                  invoiceNumber: `AFTER-${Date.now()}`,
                  invoiceDate: b.cutoverDate,
                  dueDate: b.cutoverDate,
                  status: 'sent',
                  lines: [
                    {
                      description: 'First sale in FinMatrix',
                      quantity: '1',
                      unitPrice: '5000',
                      taxRate: '18',
                      itemId: item.id,
                    },
                  ],
                } as any);
              hit = await m.query(
                `SELECT DISTINCT a.account_number AS number, a.system_role AS role FROM general_ledger g JOIN accounts a ON a.id = g.account_id
                  WHERE g.company_id = $1 AND g.source_id = $2`,
                [companyId, invoice.id],
              );
              throw new Error('roll back');
            })
            .catch((e: Error) => {
              if (e.message !== 'roll back') throw e;
            });
          const roles = Object.fromEntries(hit.map((x) => [x.role, x.number]));
          ok(
            'clash: a new invoice posts to the adopted accounts (receivables 1100, sales 4000, tax 2300, stock 1001, cost 5000)',
            roles.accounts_receivable === '1100' &&
              roles.sales_revenue === '4000' &&
              roles.sales_tax_payable === '2300' &&
              roles.inventory === '1001' &&
              roles.cogs === '5000',
            hit,
          );

          // Account for account — number, name, type, kind, role, balance —
          // the chart without roles ends exactly as the chart with them.
          const chart: unknown[] = await h.ds.query(
            `SELECT account_number AS number, name, type, sub_type AS "subType", system_role AS role,
                    is_active AS active, balance::text AS balance
               FROM accounts WHERE company_id = $1 ORDER BY account_number`,
            [companyId],
          );
          if (!legacy) clashChart = chart;
          else {
            const before = clashChart;
            ok(
              'clash, chart written before roles: it ends exactly as the chart with roles',
              before !== null &&
                JSON.stringify(chart) === JSON.stringify(before),
              before === null
                ? 'run clash-sage-numbering first'
                : chart
                    .map((row, i) => [row, before[i]])
                    .filter(([x, y]) => JSON.stringify(x) !== JSON.stringify(y))
                    .slice(0, 6),
            );
          }
        },
      } as Case;
    }),
  ];
  const only = process.argv.slice(2);
  const h = await bootHarness();
  const t0 = Date.now();
  try {
    for (const c of cases)
      if (!only.length || only.some((o) => c.folder.startsWith(o)))
        await runCase(h, b, c);
    if (!only.length || only.includes('cutover')) {
      console.log(
        '\n── reports as of another date: the cutover date is put right in one click',
      );
      const { companyId, user } = await freshCompany(
        h.ds,
        `cutover-${Date.now()}`,
      );
      await h.ds.query(
        `UPDATE companies SET fiscal_year_start_month = $2 WHERE id = $1`,
        [companyId, b.fiscalYearStartMonth],
      );
      // The owner picks a later cutover than the reports are for.
      const batch = await h.svc.create(companyId, user, {
        sourceSystem: 'zoho_books',
        cutoverDate: '2026-11-19',
      } as any);
      await h.svc.addFiles(
        companyId,
        user,
        batch.id,
        Object.entries(await zohoFiles(b)).map(([name, buffer]) =>
          upload(buffer, name),
        ),
      );
      const dated = (
        await h.ds.manager.find(MigrationIssue, {
          where: { batchId: batch.id },
        })
      ).filter((i) => i.code === 'SOURCE_REPORT_DATE' && !i.resolution);
      const offer = dated[0]?.options?.find(
        (o) => o.value === `cutover:${b.cutoverDate}`,
      );
      ok(
        `every report as of ${b.openingDate}: each date problem offers the cutover ${b.cutoverDate}`,
        dated.length === 4 &&
          dated.every((i) =>
            i.options?.some((o) => o.value === `cutover:${b.cutoverDate}`),
          ),
        dated.map((i) => [i.message.slice(0, 80), i.options]),
      );
      let refused = false;
      try {
        await h.svc.resolveIssue(companyId, user, batch.id, dated[0].id, {
          action: 'map',
          value: 'cutover:2026-08-01',
        } as any);
      } catch {
        refused = true;
      }
      ok('a cutover date that was not offered is refused', refused);
      await h.svc.resolveIssue(companyId, user, batch.id, dated[0].id, {
        action: 'map',
        value: offer!.value,
      } as any);
      const after = await h.svc.get(companyId, batch.id);
      const left = (
        await h.ds.manager.find(MigrationIssue, {
          where: { batchId: batch.id },
        })
      ).filter((i) => i.code === 'SOURCE_REPORT_DATE' && !i.resolution);
      ok(
        `one click: the cutover is ${b.cutoverDate} and no date problem is left`,
        after.cutoverDate === b.cutoverDate && left.length === 0,
        { cutover: after.cutoverDate, left: left.length },
      );
      const v = await h.svc.validate(companyId, user, batch.id);
      ok(
        'then all eleven checks pass',
        (v.checks ?? []).length === 11 &&
          (v.checks ?? []).every((x: any) => x.passed),
        (v.checks ?? []).filter((x: any) => !x.passed).map((x: any) => x.code),
      );
    }
    if (!only.length || only.includes('mutations')) {
      console.log('\n── report exports that must be refused');
      const reports = await peachtreeReports(b);
      const files = (over: Record<string, Buffer | null>) =>
        Object.entries({ ...reports, ...over })
          .filter(([, v]) => v !== null)
          .map(([name, buffer]) => ({ name, buffer: buffer! }));
      // A printed total off by one rupee.
      const tamperedTb = await editSheet(
        reports['General Ledger Trial Balance.xlsx'],
        (ws) => {
          const last = ws.lastRow!;
          last.getCell(3).value = Number(last.getCell(3).value) + 1;
        },
      );
      await mutation(
        h,
        b,
        'a trial balance whose printed total is off by Rs 1 is refused, naming the row',
        'peachtree',
        files({ 'General Ledger Trial Balance.xlsx': tamperedTb }),
        'SOURCE_TOTALS_MISMATCH',
        /row \d+ .*prints debit/,
      );
      // A detail line changed: its party subtotal no longer agrees.
      const tamperedAr = await editSheet(
        reports['Aged Receivables.xlsx'],
        (ws) => {
          for (let r = 1; r <= ws.rowCount; r++) {
            const doc = ws.getRow(r).getCell(3).value;
            if (doc && String(doc).startsWith('INV-')) {
              ws.getRow(r).getCell(9).value =
                Number(ws.getRow(r).getCell(9).value) + 100;
              break;
            }
          }
        },
      );
      await mutation(
        h,
        b,
        'an invoice changed in the aged receivables is refused (its customer total disagrees)',
        'peachtree',
        files({ 'Aged Receivables.xlsx': tamperedAr }),
        'SOURCE_TOTALS_MISMATCH',
        /add up to/,
      );
      // A report of the wrong date.
      const stale = await editSheet(reports['Aged Payables.xlsx'], (ws) => {
        ws.getRow(3).getCell(1).value = 'As of Aug 31, 2026';
      });
      await mutation(
        h,
        b,
        'a report as of another date is refused, saying which date it must be',
        'peachtree',
        files({ 'Aged Payables.xlsx': stale }),
        'SOURCE_REPORT_DATE',
        /as of 2026-08-31; it must be as of 2026-09-30/,
      );
      // A report the balances need is missing.
      await mutation(
        h,
        b,
        'without the aged receivables (the TB has receivables) the import waits for it',
        'peachtree',
        files({ 'Aged Receivables.xlsx': null }),
        'SOURCE_REPORTS_MISSING',
        /Aged receivables/,
      );
    }
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

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
