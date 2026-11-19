/**
 * Writes the Migration Center sample kit: the same invented company's books
 * in every format FinMatrix reads, one folder per source, each with a README
 * (account, steps, expected result). Never committed; never uploaded anywhere
 * but the local test stack.
 *
 *   npm run migration:samples                    # → ~/FinMatrix-Migration-Samples
 *   npm run migration:samples -- --out /path     # elsewhere
 */
import AdmZip from 'adm-zip';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expectedResults, fmtDate, SampleBooks, sampleBooks } from './books';
import { genericWorkbook, peachtreeReports, starterWorkbook, tallyFiles } from './writers/basic';
import { quickbooksDesktop, quickbooksOnline } from './writers/quickbooks';
import { largeQuickbooksExport } from './writers/large';
import { xeroFiles, zohoFiles } from './writers/xero-zoho';
import { PASSWORD, TEST_ACCOUNTS } from '../local/seed-test-accounts';

const WEB = 'http://localhost:5174';

interface Folder {
  folder: string;
  title: string;
  /** What to choose as "Moving from". */
  source: string;
  status: 'ready' | 'coming';
  comingNote?: string;
  steps: string[];
  files: Record<string, Buffer | string>;
  expect?: string[];
  /** What FinMatrix will ask the owner to confirm (Match step). */
  confirm?: string[];
}

const arg = (name: string) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

function accountFor(folder: string) {
  const a = TEST_ACCOUNTS.find((t) => t.folder === folder);
  if (!a) throw new Error(`no test account for ${folder}`);
  return a;
}

function expectedLines(b: SampleBooks): string[] {
  const e = expectedResults(b);
  return [
    `Trial balance: debits = credits = **Rs ${e.trialBalanceTotal}**`,
    `Receivables (open invoices): **Rs ${e.receivables}** across ${e.openInvoices} invoices`,
    `Payables (open bills): **Rs ${e.payables}** across ${e.openBills} bills`,
    `Stock: **Rs ${e.inventory}**`,
    `Retained earnings (earlier years): **Rs ${e.retainedEarnings}**`,
    `Profit July–September 2026: **Rs ${e.profitYearToDate}**`,
    `Created: ${e.customers} customers, ${e.vendors} vendors, ${e.items} items`,
    'All eleven checks pass at zero difference; after Import, Migration Clearing (3950) is 0.',
  ];
}

/** "1 October 2026". */
const longDate = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

/** The one setting every test depends on, said first. */
const cutoverNote = (b: SampleBooks) =>
  `> **Cutover date: ${longDate(b.cutoverDate)}.** Choose it on the Start step: every file here is as of ${longDate(b.openingDate)}, the day before. (Pick another date and FinMatrix says so, and offers to change it in one click.)`;

function readme(b: SampleBooks, f: Folder): string {
  const a = accountFor(f.folder);
  const lines = [
    `# ${f.folder} — ${f.title}`,
    '',
    f.status === 'ready' ? '**Status: ready to test.**' : `**Status: coming — ${f.comingNote ?? 'not yet readable'}.**`,
    '',
    cutoverNote(b),
    '',
    '## Sign in',
    '',
    `- Web: ${WEB}`,
    `- Email: \`${a.email}\``,
    `- Password: \`${PASSWORD}\``,
    `- Company: ${a.company} (empty books, fiscal year starts in ${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][a.fiscalYearStartMonth - 1]})`,
    '',
    '## Steps',
    '',
    `1. Settings → Move to FinMatrix → start a migration. Moving from: **${f.source}**. Cutover date: **${fmtDate.dmy(b.cutoverDate)}** (opening balances as at ${fmtDate.dmy(b.openingDate)}).`,
    ...f.steps.map((s, i) => `${i + 2}. ${s}`),
    `${f.steps.length + 2}. Run the checks, review the certificate, tick the spot checks, sign off, Import.`,
    `${f.steps.length + 3}. To test again: Undo on the Import step (or \`scripts/local/reset.sh\` to start every account afresh).`,
    '',
    '## Files',
    '',
    ...Object.keys(f.files).map((n) => `- \`${n}\``),
    '',
    ...(f.confirm?.length
      ? ['## FinMatrix will ask you to confirm', '', ...f.confirm.map((c) => `- ${c}`), '']
      : ['## FinMatrix will ask you to confirm', '', '- Nothing: every sheet, column and account is recognised.', '']),
    '## Expected result',
    '',
    ...(f.expect ?? expectedLines(b)).map((l) => `- ${l}`),
    '',
    'If anything differs — a figure, a question you did not expect, an error — note the folder, the step and the message, and send it.',
    '',
  ];
  return lines.join('\n');
}

async function main() {
  const out = arg('--out') ?? path.join(os.homedir(), 'FinMatrix-Migration-Samples');
  const b = sampleBooks();
  const tally = tallyFiles(b);
  const tallyZip = new AdmZip();
  for (const [n, s] of Object.entries(tally)) tallyZip.addFile(n, Buffer.from(s, 'utf8'));
  const reports = await peachtreeReports(b);
  const proofOnly = Object.fromEntries(
    Object.entries(reports).filter(([n]) => !/List|Chart of Accounts/.test(n)),
  );

  const folders: Folder[] = [
    {
      folder: '01-starter',
      title: 'FinMatrix starter workbook',
      source: 'FinMatrix starter workbook',
      status: 'ready',
      steps: ['Upload `Indus Valley Distributors - Starter Workbook.xlsx`.'],
      files: { 'Indus Valley Distributors - Starter Workbook.xlsx': await starterWorkbook(b) },
    },
    {
      folder: '02-peachtree-backup',
      title: 'Peachtree / Sage 50 US backup (.ptb)',
      source: 'Peachtree / Sage 50',
      status: 'coming',
      comingNote:
        'the invented .ptb backup is generated with the large samples. Until then, test Peachtree with your own backup: sign in as `peachtree.real@finmatrix.local`, cutover 06/10/2026, and upload your .ptb plus its four reports',
      steps: ['Upload the `.ptb` backup and the four Peachtree reports in this folder.'],
      files: proofOnly,
    },
    {
      folder: '03-peachtree-reports-only',
      title: 'Peachtree / Sage 50 US — reports only (any version)',
      source: 'Peachtree / Sage 50',
      status: 'ready',
      steps: [
        'Upload all eight report exports in this folder (no backup). Each is ticked off as it is recognised.',
        'Nothing to match: every report is recognised by its columns, and every total it prints is checked against its lines.',
      ],
      files: reports,
    },
    {
      folder: '04-tally',
      title: 'TallyPrime / Tally ERP 9 (XML)',
      source: 'TallyPrime',
      status: 'ready',
      steps: ['Upload the five XML files together, or `tally-export.zip` (the same five in one ZIP).', 'Match step: confirm the two account proposals listed below.'],
      files: { ...tally, 'tally-export.zip': tallyZip.toBuffer() },
      confirm: [
        'Account "Sales Tax Payable" → FinMatrix 2300 Sales Tax Payable (same name). Confirm.',
        'Account "Cost of Goods Sold" → FinMatrix 5000 Cost of Goods Sold (same name). Confirm.',
      ],
      expect: [
        ...expectedLines(b).slice(0, 6),
        'Account numbers differ from the other formats: Tally has none, so FinMatrix numbers new ledgers by type (18001…, 28001…, 48001…, 68001…). Totals are identical.',
        'All eleven checks pass at zero difference.',
      ],
    },
    {
      folder: '05-quickbooks-online',
      title: 'QuickBooks Online',
      source: 'QuickBooks Online',
      status: 'ready',
      steps: [
        'Upload all six files: the "Export data" ZIP (trial balance, customer and vendor lists — its general ledger, journal, P&L and balance sheet are recognised and skipped) and the five reports beside it.',
        'Match step: confirm the two account proposals listed below.',
      ],
      files: await quickbooksOnline(b),
      confirm: [
        'Account "Sales Tax Payable" → FinMatrix 2300 Sales Tax Payable (same name). Confirm.',
        'Account "Cost of Goods Sold" → FinMatrix 5000 Cost of Goods Sold (same name). Confirm.',
      ],
      expect: [
        ...expectedLines(b).slice(0, 7),
        'QuickBooks Online numbers no accounts by default: FinMatrix numbers them — receivables 1100, inventory 1200, payables 2000, retained earnings 3100, the rest by type (18001…, 28001…, 38001…, 48001…, 68001…). Totals are identical.',
        'Customers and vendors get FinMatrix codes (C-0001…, V-0001…): QuickBooks has none.',
        "All eleven checks pass at zero difference, including Matches the source's own reports (every total each report prints).",
      ],
    },
    {
      folder: '06-quickbooks-desktop',
      title: 'QuickBooks Desktop (Pro, Premier, Enterprise, Mac)',
      source: 'QuickBooks Desktop',
      status: 'ready',
      steps: [
        'Upload all five files: the IIF lists (accounts, customers, vendors, items), the trial balance (CSV) and the three reports.',
        'Nothing to match. The non-posting "Purchase Orders" account and the "Delivery Charge" service item are left out; the job "Al-Madina Karyana Store:Gulberg Branch" comes in under its customer.',
      ],
      files: await quickbooksDesktop(b),
      expect: [
        ...expectedLines(b).slice(0, 7),
        "All eleven checks pass at zero difference, including Matches the source's own reports.",
      ],
    },
    {
      folder: '07-xero',
      title: 'Xero',
      source: 'Xero',
      status: 'ready',
      steps: [
        'Upload all seven files: the chart of accounts, contacts and products and services (CSV) and the four reports — Trial Balance, Aged Receivables Detail, Aged Payables Detail, Inventory Item List (Excel).',
        'Nothing to match.',
      ],
      files: await xeroFiles(b),
      expect: [
        ...expectedLines(b).slice(0, 6),
        `Created: ${b.customers.length - 1} customers, ${b.vendors.length - 1} vendors, ${b.items.length} items. Xero's contact list does not mark customers and suppliers, so the two contacts with nothing open (Hamza Brothers, Ravi Beverages) are named in a warning instead of being guessed.`,
        'The trial balance\'s year-to-date columns are used (the pair that balances).',
        "All eleven checks pass at zero difference, including Matches the source's own reports.",
      ],
    },
    {
      folder: '08-zoho-books',
      title: 'Zoho Books',
      source: 'Zoho Books',
      status: 'ready',
      steps: [
        'Upload all eight files: the chart of accounts, customers, vendors and items (each exported from its list page → More → Export, as CSV) and the four reports.',
        'Nothing to match.',
      ],
      files: await zohoFiles(b),
      expect: [...expectedLines(b).slice(0, 7), "All eleven checks pass at zero difference, including Matches the source's own reports."],
    },
    {
      folder: '15-generic-excel',
      title: 'Generic Excel (any accounting system, "as exported")',
      source: 'Spreadsheet (any other system)',
      status: 'ready',
      steps: [
        'Upload `Indus Valley Distributors - Books.xlsx`.',
        'Match step: confirm the six proposals listed below.',
      ],
      files: { 'Indus Valley Distributors - Books.xlsx': await genericWorkbook(b) },
      confirm: [
        'Sheet "Chart" → Accounts. Confirm.',
        'Sheet "Party Balances" → Open invoices. Confirm.',
        'Sheet "Creditors O-S" → Open bills. Confirm.',
        'Column "Account Title" → Account name. Confirm.',
        'Account 1000 Cash in Hand → 1000 Cash (same number, the names differ). Confirm.',
        "Account 3000 Owner's Capital → 3000 Owner Equity (same number, the names differ). Confirm.",
      ],
    },
  ];

  fs.mkdirSync(out, { recursive: true });
  for (const f of folders) {
    const dir = path.join(out, f.folder);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    for (const [n, content] of Object.entries(f.files)) fs.writeFileSync(path.join(dir, n), content);
    fs.writeFileSync(path.join(dir, 'README.md'), readme(b, f));
    console.log(`${f.status === 'ready' ? 'ready ' : 'coming'}  ${f.folder}  (${Object.keys(f.files).length} files)`);
  }

  const top = [
    '# FinMatrix Migration Center — sample kit',
    '',
    `Invented books for **${b.company}** (no real business data), written in every format FinMatrix reads. Every folder must give the same result. Generated by \`npm run migration:samples\` in FinMatrix-Backend.`,
    '',
    '## Run the local test stack (its own database; production is never touched)',
    '',
    '```',
    'cd ~/FinMatrix-Backend/FinMatrix-Backend && scripts/local/api-host.sh   # API on :3100, its own database on :5434',
    'cd ~/FinMatrix-Web && VITE_API_URL=http://localhost:3100/api/v1 npx vite --port 5174 --strictPort',
    '```',
    '',
    'For fresh data and new accounts, `scripts/local/reset.sh` instead of the first line (it rebuilds the Docker image, which is slow on a slow connection).',
    '',
    `Then open ${WEB}. Every account's password is \`${PASSWORD}\`.`,
    '',
    cutoverNote(b),
    '',
    '| Folder | Status | Sign in as |',
    '|---|---|---|',
    ...folders.map((f) => `| [${f.folder}](${f.folder}/README.md) | ${f.status} | \`${accountFor(f.folder).email}\` |`),
    '',
    '## Expected result (every folder)',
    '',
    ...expectedLines(b).map((l) => `- ${l}`),
    '',
  ].join('\n');
  fs.writeFileSync(path.join(out, 'README.md'), top);

  // The large sample takes a couple of minutes and ~420 MB: only with --large.
  if (process.argv.includes('--large')) {
    const f: Folder = {
      folder: '90-large',
      title: 'Large export (QuickBooks Online "Export data" with years of history)',
      source: 'QuickBooks Online',
      status: 'ready',
      steps: [
        'Upload `QuickBooks Online - Export data (large).zip` (~420 MB). It goes up in 8 MB pieces with a progress bar, and resumes if the connection drops; then the server reads it in the background.',
        'Its general ledger and journal (millions of lines) are recognised and skipped without being loaded; its trial balance and customer and vendor lists are kept.',
        'Then upload the five reports beside it (the Account List, both aging details, the Product/Service List and the Inventory Valuation Summary).',
        'Match step: confirm the two account proposals (Sales Tax Payable → 2300, Cost of Goods Sold → 5000).',
      ],
      files: {},
    };
    const dir = path.join(out, f.folder);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const rows = Number(arg('--ledger-rows') ?? 3_400_000);
    const big = await largeQuickbooksExport(b, path.join(dir, 'QuickBooks Online - Export data (large).zip'), rows);
    for (const [n, buf] of Object.entries(big.others)) fs.writeFileSync(path.join(dir, n), buf);
    f.files = { 'QuickBooks Online - Export data (large).zip': Buffer.alloc(0), ...big.others };
    f.expect = [
      `The ZIP is ${(big.size / 1_048_576).toFixed(0)} MB: ${rows.toLocaleString()} general-ledger and ${rows.toLocaleString()} journal lines, skipped.`,
      ...expectedLines(b),
    ];
    fs.writeFileSync(path.join(dir, 'README.md'), readme(b, f));
    console.log(`ready   ${f.folder}  (${(big.size / 1_048_576).toFixed(0)} MB ZIP + 5 reports)`);
  }
  console.log(`\nwritten to ${out}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
