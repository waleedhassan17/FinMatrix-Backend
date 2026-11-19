/**
 * Migration Center — a Peachtree / Sage 50 backup, end to end, in process.
 * ========================================================================
 *   1. The backup goes up in 8 MB pieces (one piece sent twice, as a retry
 *      would) and the background reader reads it.
 *   2. Its own cross-checks pass; what the owner must decide is raised
 *      (control differences, net credits), and Peachtree's reports are
 *      required.
 *   3. A report that disagrees with the backup blocks the import.
 *   4. With Peachtree's reports and the owner's acceptances: all eleven
 *      checks pass, sign-off, commit.
 *   5. The books FinMatrix now holds are Peachtree's: the trial balance per
 *      account, receivables and payables per party, stock, retained earnings
 *      and the year to date.
 *   6. Undo empties the books again.
 *
 * The backup is the owner's and never enters the repository:
 *   PTB_SAMPLE=/path/to/company.ptb npx ts-node -r tsconfig-paths/register test/migration-peachtree.acceptance.ts
 * Peachtree's own report exports (.xlsx) can be given with PTB_REPORTS_DIR;
 * without them the test writes reports in Peachtree's layout from the
 * backup's own figures, which proves the pipeline but not Peachtree's
 * printing — that proof needs the real exports.
 */
import './migration-harness.env';
import Decimal from 'decimal.js';
import * as ExcelJS from 'exceljs';
import { open, readdir, readFile } from 'fs/promises';
import { basename, join } from 'path';
import { asUpload, bootHarness, freshCompany } from './migration-harness';
import { MigrationUploadsService } from '../src/modules/migrations/uploads/migration-uploads.service';
import { MigrationReadWorker } from '../src/modules/migrations/uploads/migration-read.worker';
import { MigrationFile } from '../src/modules/migrations/entities/migration-file.entity';
import { MigrationIssue } from '../src/modules/migrations/entities/migration-issue.entity';
import { PeachtreeExtract } from '../src/modules/migrations/sources/peachtree/peachtree-books';
import { StorageService } from '../src/common/storage/storage.service';
import { PartyLedgerService } from '../src/modules/ledger/party-ledger.service';

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
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 900) : ''}`,
    );
  }
};
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const asOf = (iso: string) =>
  `As of ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${Number(iso.slice(8))}, ${iso.slice(0, 4)}`;

/** Peachtree's report layout: title lines, a header row, lines, a total. */
async function report(
  company: string,
  title: string,
  date: string,
  header: string[],
  rows: Array<Array<string | number | null>>,
) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.addRow([company]);
  ws.addRow([title]);
  ws.addRow([asOf(date)]);
  ws.addRow(['Filter Criteria includes: Report order is by ID.']);
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function syntheticReports(
  x: PeachtreeExtract,
  opts: { tamperAccount?: string; inventoryShort?: string },
) {
  const d = x.source.openingDate;
  const out: Array<{ name: string; buffer: Buffer }> = [];
  const tb = x.peachtree.accounts
    .filter((a) => !new Decimal(a.balance).isZero())
    .map((a) => {
      let b = new Decimal(a.balance);
      if (opts.tamperAccount === a.id) b = b.plus(1);
      return [
        a.id,
        a.name,
        b.greaterThan(0) ? Number(b.toFixed(2)) : null,
        b.lessThan(0) ? Number(b.negated().toFixed(2)) : null,
      ];
    });
  out.push({
    name: 'Trial Balance.xlsx',
    buffer: await report(
      x.source.company,
      'General Ledger Trial Balance',
      d,
      ['Account ID', 'Account Description', 'Debit Amt', 'Credit Amt'],
      [...tb, ['', 'Total:', null, null]],
    ),
  });
  const aged = (
    parties: Array<{ id: string; name: string; balance: string }>,
  ) =>
    parties
      .filter((p) => !new Decimal(p.balance).isZero())
      .flatMap((p) => [
        [p.id, p.name, null, null, null, null, null, null, null],
        [
          null,
          null,
          'BALANCE',
          d,
          Number(p.balance),
          null,
          null,
          null,
          Number(p.balance),
        ],
        [
          null,
          `${p.id} Total`,
          null,
          null,
          Number(p.balance),
          null,
          null,
          null,
          Number(p.balance),
        ],
      ]);
  const agedHeader = (id: string, name: string) => [
    id,
    name,
    'Invoice/CM #',
    'Date',
    '0 - 30',
    '31 - 60',
    '61 - 90',
    'Over 90 days',
    'Amount Due',
  ];
  out.push({
    name: 'Aged Receivables.xlsx',
    buffer: await report(
      x.source.company,
      'Aged Receivables',
      d,
      agedHeader('Customer ID', 'Customer'),
      aged(x.peachtree.customers),
    ),
  });
  out.push({
    name: 'Aged Payables.xlsx',
    buffer: await report(
      x.source.company,
      'Aged Payables',
      d,
      agedHeader('Vendor ID', 'Vendor'),
      aged(x.peachtree.vendors),
    ),
  });
  // Values: the inventory account spread over the items by quantity, less
  // `inventoryShort` (entries posted straight to the account).
  const stocked = x.peachtree.items.filter(
    (i) => !new Decimal(i.quantity).isZero(),
  );
  const target = new Decimal(x.stock.ledgerBalance).minus(
    opts.inventoryShort ?? 0,
  );
  const qtyTotal = stocked.reduce((t, i) => t.plus(i.quantity), new Decimal(0));
  let left = target;
  const iv = stocked.map((i, k) => {
    const v =
      k === stocked.length - 1
        ? left
        : target.times(i.quantity).dividedBy(qtyTotal).toDecimalPlaces(2);
    left = left.minus(v);
    return [
      i.sku,
      i.name,
      'Each',
      'Average',
      Number(i.quantity),
      Number(v.toFixed(2)),
      Number(v.dividedBy(i.quantity).toFixed(4)),
      null,
    ];
  });
  out.push({
    name: 'Inventory Valuation.xlsx',
    buffer: await report(
      x.source.company,
      'Inventory Valuation Report',
      d,
      [
        'Item ID',
        'Item Description',
        'Stocking U/M',
        'Cost Method',
        'Qty on Hand',
        'Item Value',
        'Avg Cost',
        '% of Inv Value',
      ],
      iv,
    ),
  });
  return out;
}

async function main() {
  const sample = process.env.PTB_SAMPLE;
  if (!sample) {
    console.log(
      "PTB_SAMPLE is not set: skipped (the backup is the owner's and is not in the repository).",
    );
    return;
  }
  const h = await bootHarness();
  const uploads = h.app.get(MigrationUploadsService);
  const worker = h.app.get(MigrationReadWorker);
  const storage = h.app.get(StorageService);
  const ledger = h.app.get(PartyLedgerService);
  const t0 = Date.now();
  try {
    console.log('\n── 1. Upload in pieces and read');
    const { companyId, user } = await freshCompany(
      h.ds,
      `peachtree-${Date.now()}`,
    );
    await h.ds.query(
      `UPDATE companies SET fiscal_year_start_month = 6 WHERE id = $1`,
      [companyId],
    );
    const batch = await h.svc.create(companyId, user, {
      sourceSystem: 'peachtree',
      cutoverDate: process.env.PTB_CUTOVER ?? '2026-10-06',
    });
    const fh = await open(sample, 'r');
    const { size } = await fh.stat();
    const started = await uploads.start(companyId, user, batch.id, {
      name: basename(sample),
      size,
    });
    ok(
      'upload starts with the right number of pieces',
      started.parts === Math.ceil(size / started.partSize),
      started,
    );
    const resumed = await uploads.start(companyId, user, batch.id, {
      name: basename(sample),
      size,
    });
    ok('starting it again resumes the same upload', resumed.id === started.id);
    const tUp = Date.now();
    for (let n = 0; n < started.parts; n++) {
      const len = Math.min(started.partSize, size - n * started.partSize);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, n * started.partSize);
      await uploads.putPart(companyId, batch.id, started.id, n, buf);
      if (n === 1)
        await uploads.putPart(companyId, batch.id, started.id, n, buf); // a retried piece
    }
    await fh.close();
    let wrongSize: unknown = null;
    try {
      await uploads.putPart(
        companyId,
        batch.id,
        started.id,
        0,
        Buffer.alloc(10),
      );
    } catch (e: any) {
      wrongSize = e?.response?.code;
    }
    ok(
      'a piece of the wrong size is refused',
      wrongSize === 'MIGRATION_UPLOAD_PART_CORRUPT',
      wrongSize,
    );
    const done = await uploads.complete(companyId, batch.id, started.id);
    ok(
      'complete: every piece arrived, queued for reading',
      done.status === 'received',
      done,
    );
    console.log(
      `     ${started.parts} pieces in ${((Date.now() - tUp) / 1000).toFixed(1)} s`,
    );
    const tRead = Date.now();
    const rss0 = process.memoryUsage().rss;
    const claimed = await worker.runOnce();
    const readMs = Date.now() - tRead;
    const after = await uploads.status(companyId, batch.id, started.id);
    ok(
      'the background reader read the backup',
      claimed?.id === started.id && after.status === 'read',
      after,
    );
    console.log(
      `     read + analysed in ${(readMs / 1000).toFixed(1)} s, RSS ${Math.round(rss0 / 1e6)} → ${Math.round(process.memoryUsage().rss / 1e6)} MB`,
    );
    const [{ n: parts }] = await h.ds.query(
      `SELECT COUNT(*)::int AS n FROM migration_upload_parts WHERE upload_id = $1`,
      [started.id],
    );
    ok('its pieces are deleted once read', parts === 0, parts);
    const file = await h.ds.manager.findOneOrFail(MigrationFile, {
      where: { batchId: batch.id, kind: 'ptb' },
    });
    ok(
      "the backup is the batch's file, with its own size and SHA-256",
      file.sizeBytes === size && /^[0-9a-f]{64}$/.test(file.sha256),
      { size: file.sizeBytes, sha: file.sha256 },
    );
    const stored = await storage.read(file.storageKey);
    const chunks: Buffer[] = [];
    for await (const c of stored!.stream)
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const extract = JSON.parse(
      Buffer.concat(chunks).toString('utf8'),
    ) as PeachtreeExtract;

    console.log('\n── 2. What the owner must see');
    const issues = async () =>
      h.ds.manager.find(MigrationIssue, { where: { batchId: batch.id } });
    let list = await issues();
    const codes = (l: MigrationIssue[]) => l.map((i) => i.code);
    ok(
      'the backup agrees with itself (no failed cross-check)',
      !codes(list).includes('PEACHTREE_CROSSCHECK_FAILED'),
      list
        .filter((i) => i.code === 'PEACHTREE_CROSSCHECK_FAILED')
        .map((i) => i.message),
    );
    ok(
      'no entries after the cutover',
      !codes(list).includes('PEACHTREE_POSTED_AFTER_CUTOVER'),
    );
    ok(
      'the fiscal years agree (June)',
      !codes(list).includes('PEACHTREE_FISCAL_YEAR'),
    );
    ok(
      "Peachtree's reports are required",
      codes(list).includes('PEACHTREE_REPORTS_MISSING'),
    );
    const acceptable = list.filter((i) =>
      (i.options ?? []).some((o) => o.value === 'accept'),
    );
    console.log(`     to accept: ${acceptable.map((i) => i.field).join(', ')}`);

    console.log('\n── 3. A report that disagrees blocks');
    const reportsDir = process.env.PTB_REPORTS_DIR;
    const real = reportsDir
      ? await Promise.all(
          (await readdir(reportsDir))
            .filter((f) => f.toLowerCase().endsWith('.xlsx'))
            .map(async (f) => ({
              name: f,
              buffer: await readFile(join(reportsDir, f)),
            })),
        )
      : null;
    const tamperId = extract.peachtree.accounts.find(
      (a) => !new Decimal(a.balance).isZero(),
    )!.id;
    if (!real) {
      const bad = await syntheticReports(extract, {
        tamperAccount: tamperId,
        inventoryShort: '1000.00',
      });
      await h.svc.addFiles(
        companyId,
        user,
        batch.id,
        bad.map((r) => asUpload(r.buffer, r.name)),
      );
      list = await issues();
      const mismatch = list.find((i) => i.code === 'PEACHTREE_REPORT_MISMATCH');
      ok(
        'a trial balance off by Rs 1 on one account is caught, naming it',
        !!mismatch && mismatch.message.includes(tamperId),
        mismatch?.message,
      );
      for (const f of await h.ds.manager.find(MigrationFile, {
        where: { batchId: batch.id },
      }))
        if (f.kind !== 'ptb')
          await h.svc.removeFile(companyId, user, batch.id, f.id);
    }

    console.log('\n── 4. With the reports and the acceptances: eleven checks');
    const reports =
      real ?? (await syntheticReports(extract, { inventoryShort: '1000.00' }));
    console.log(
      `     reports: ${real ? "Peachtree's own exports" : 'written from the backup (pipeline proof only)'}`,
    );
    await h.svc.addFiles(
      companyId,
      user,
      batch.id,
      reports.map((r) => asUpload(r.buffer, r.name)),
    );
    list = await issues();
    ok(
      'no report missing or disagreeing',
      !codes(list).some(
        (c) =>
          c === 'PEACHTREE_REPORTS_MISSING' ||
          c === 'PEACHTREE_REPORT_MISMATCH',
      ),
      list
        .filter((i) => i.code.startsWith('PEACHTREE_REPORT'))
        .map((i) => i.message),
    );
    for (const i of list.filter((x) =>
      (x.options ?? []).some((o) => o.value === 'accept'),
    ))
      await h.svc.resolveIssue(companyId, user, batch.id, i.id, {
        action: 'map',
        value: 'accept',
      } as any);
    // Accounts FinMatrix suggests merging into its own (same name, below
    // full confidence): the owner confirms each, as the mapping step asks.
    const maps = await h.svc.getMappings(companyId, batch.id);
    const review = maps.mappings.account.filter(
      (m) => m.needsReview && m.target,
    );
    console.log(`     account suggestions confirmed: ${review.length}`);
    if (review.length)
      await h.svc.patchMappings(
        companyId,
        user,
        batch.id,
        review.map((m) => ({
          kind: 'account' as const,
          source: m.source,
          target: m.target,
        })),
      );
    list = await issues();
    const blocking = list.filter((i) => i.severity === 'blocking');
    ok(
      'nothing left blocking',
      blocking.length === 0,
      blocking.map((i) => `${i.code}: ${i.message.slice(0, 200)}`),
    );
    const v = await h.svc.validate(companyId, user, batch.id);
    const failed = (v.checks ?? []).filter((c: any) => !c.passed);
    ok(
      'all eleven checks pass',
      (v.checks ?? []).length === 11 && failed.length === 0,
      failed.map(
        (c: any) =>
          `${c.code} ${c.expected} ${c.actual} ${JSON.stringify(c.details).slice(0, 300)}`,
      ),
    );
    const proof = (v.checks ?? []).find(
      (c: any) => c.code === 'SOURCE_REPORTS_MATCH',
    );
    console.log(`     proof: ${proof?.expected} → ${proof?.actual}`);
    ok('ready to import', v.status === 'ready' && v.readiness === 100, {
      status: v.status,
      readiness: v.readiness,
    });
    await h.svc.signOff(companyId, user, batch.id, {
      confirmed: true,
      spotCheckDone: true,
    });
    const tCommit = Date.now();
    await h.svc.commit(companyId, user, batch.id);
    console.log(
      `     committed in ${((Date.now() - tCommit) / 1000).toFixed(1)} s`,
    );

    console.log("\n── 5. FinMatrix's books are Peachtree's");
    const tb = await h.reports.trialBalance(
      companyId,
      '1970-01-01',
      '2999-12-31',
    );
    ok('trial balance balances', tb.isBalanced, {
      dr: tb.totalDebits,
      cr: tb.totalCredits,
    });
    /** A system account's balance, found by its role (its number is Peachtree's). */
    const balOf = async (role: string) =>
      new Decimal(
        (
          await h.ds.query(
            `SELECT balance::text AS b FROM accounts WHERE company_id = $1 AND system_role = $2`,
            [companyId, role],
          )
        )[0]?.b ?? 0,
      );
    const custTotal = extract.peachtree.customers.reduce(
      (t, p) => t.plus(p.balance),
      new Decimal(0),
    );
    const credit = extract.findings.some((f) => f.key === 'customer-credits');
    const [ar] = await h.ds.query(
      `SELECT COALESCE(SUM(balance),0)::text AS b FROM invoices WHERE company_id = $1`,
      [companyId],
    );
    ok(
      'open invoices + customer credits = what customers owe in Peachtree',
      new Decimal(ar.b)
        .minus(credit ? await balOf('customer_advances') : 0)
        .equals(custTotal),
      { invoices: ar.b, customers: custTotal.toFixed(2) },
    );
    const parties = await ledger.parties(companyId, 'customer');
    const ledgerTotal = parties.parties.reduce(
      (t: Decimal, p: any) => t.plus(p.closing),
      new Decimal(0),
    );
    ok(
      "customers' ledgers add up to their open invoices",
      ledgerTotal.toDecimalPlaces(2).equals(new Decimal(ar.b)),
      { ledger: ledgerTotal.toFixed(2), invoices: ar.b },
    );
    const vendTotal = extract.peachtree.vendors.reduce(
      (t, p) => t.plus(p.balance),
      new Decimal(0),
    );
    const [ap] = await h.ds.query(
      `SELECT COALESCE(SUM(balance),0)::text AS b FROM bills WHERE company_id = $1`,
      [companyId],
    );
    ok(
      'open bills = what Peachtree owes its vendors',
      new Decimal(ap.b).equals(vendTotal),
      { bills: ap.b, vendors: vendTotal.toFixed(2) },
    );
    const [stock] = await h.ds.query(
      `SELECT COALESCE(SUM(value_change),0)::text AS v FROM inventory_movements WHERE company_id = $1 AND source_type = 'migration'`,
      [companyId],
    );
    ok(
      'stock value = the Inventory Valuation total',
      new Decimal(stock.v).equals(
        new Decimal(extract.stock.ledgerBalance).minus(real ? 0 : 1000),
      ),
      { stock: stock.v, ledger: extract.stock.ledgerBalance },
    );
    // Retained earnings keeps Peachtree's own account ID now.
    const [reAcct] = await h.ds.query(
      `SELECT account_number AS number FROM accounts WHERE company_id = $1 AND system_role = 'retained_earnings'`,
      [companyId],
    );
    const re = extract.peachtree.accounts.find(
      (a) => a.number === reAcct?.number,
    );
    const bs = await h.reports.balanceSheet(companyId, batch.cutoverDate);
    const reLine = bs.equity.find((l: any) => l.accountCode === reAcct?.number);
    ok(
      "retained earnings = Peachtree's (earlier years closed into it)",
      !!re &&
        !!reLine &&
        new Decimal(reLine.amount).equals(new Decimal(re.balance).negated()),
      { finmatrix: reLine?.amount, peachtree: re?.balance },
    );
    const pnlAccounts = extract.peachtree.accounts.filter(
      (a) => a.number && /^[4-9]/.test(a.id),
    );
    void pnlAccounts;
    const pnl = await h.reports.profitLoss(
      companyId,
      '2026-06-01',
      batch.cutoverDate,
    );
    const pnlPeachtree = extract.grids
      .find((g) => g.name.startsWith('Trial Balance'))!
      .rows.slice(1)
      .filter((r) =>
        /^(Revenue|Expense)$/.test(
          String(
            extract.grids
              .find((g) => g.name.startsWith('Accounts'))!
              .rows.find((a) => a.cells[0] === r.cells[0])?.cells[2] ?? '',
          ),
        ),
      )
      .reduce(
        (t, r) => t.plus(r.cells[3] ?? 0).minus(r.cells[2] ?? 0),
        new Decimal(0),
      );
    ok(
      'year-to-date profit (Jun–Oct 2026) = the P&L lines brought in',
      new Decimal(pnl.netIncome)
        .toDecimalPlaces(2)
        .equals(pnlPeachtree.toDecimalPlaces(2)),
      { finmatrix: pnl.netIncome, peachtree: pnlPeachtree.toFixed(2) },
    );

    console.log('\n── 6. Undo');
    await h.svc.rollback(companyId, user, batch.id);
    const empty = await h.reports.trialBalance(
      companyId,
      '1970-01-01',
      '2999-12-31',
    );
    ok(
      'undo empties the trial balance',
      empty.rows.length === 0,
      empty.rows.length,
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

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
