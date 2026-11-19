/**
 * Phase 0 tool: read a Peachtree backup (.ptb) and report what FinMatrix
 * makes of it, so it can be compared with Peachtree's own reports before any
 * of it is imported. Reads only; prints to the terminal; writes nothing but
 * the extracted tables in the work folder (deleted afterwards).
 *
 *   npx ts-node -r tsconfig-paths/register scripts/peachtree-inspect.ts <file.ptb> [--work <dir>] [--keep]
 *       [--dump <Table> [--limit n]] [--fields <Table>] [--books [--cutover YYYY-MM-DD]] [--tables]
 *
 * Never point it at a backup you may not read: it prints the books.
 */
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BtrieveFile } from '../src/modules/migrations/sources/peachtree/btrieve';
import { readDictionary } from '../src/modules/migrations/sources/peachtree/ddf';
import { decodeField } from '../src/modules/migrations/sources/peachtree/field-types';
import {
  extractTables,
  inspectArchive,
} from '../src/modules/migrations/sources/peachtree/zip';
import { readPeachtreeBooks } from '../src/modules/migrations/sources/peachtree/peachtree-books';
import {
  DEFAULT_CHART_OF_ACCOUNTS,
  SYSTEM_ACCOUNT_DEFS,
} from '../src/modules/accounts/accounts.constants';
import { addDaysIso } from '../src/common/utils/business-date.util';

const TABLES = [
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
  'INVCOST.DAT',
  'VERSION.TXT',
];

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) throw new Error('usage: peachtree-inspect <file.ptb>');
  const opt = (k: string) => {
    const i = args.indexOf(k);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const work = await mkdtemp(join(opt('--work') ?? tmpdir(), 'ptb-'));
  const t0 = Date.now();
  try {
    const archive = await inspectArchive(file);
    console.log(
      `archive: ${archive.entries.length} files, comment ${JSON.stringify(archive.comment.split(/\r?\n/)[0])}`,
    );
    const paths = await extractTables(file, new Set(TABLES), work);
    console.log(
      `extracted ${paths.size} tables in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
    );
    const dict = await readDictionary(
      paths.get('FILE.DDF')!,
      paths.get('FIELD.DDF')!,
    );
    console.log(`dictionary: ${dict.size} tables`);
    const byFile = new Map<string, string>();
    for (const t of dict.values())
      byFile.set(
        t.file.toUpperCase(),
        byFile.get(t.file.toUpperCase()) ?? t.name,
      );
    for (const key of args.includes('--tables')
      ? TABLES.filter((k) => k.endsWith('.DAT'))
      : []) {
      const path = paths.get(key);
      if (!path) {
        console.log(`  ${key}: missing from the backup`);
        continue;
      }
      const table = dict.get((byFile.get(key) ?? '').toLowerCase());
      const t1 = Date.now();
      const bt = await BtrieveFile.open(path, key);
      let n = 0;
      try {
        // General.DAT holds several record types of different lengths.
        const expected =
          key === 'GENERAL.DAT' ? undefined : table?.recordLength;
        for await (const rec of bt.records(expected)) {
          n++;
          void rec;
        }
        console.log(
          `  ${key.padEnd(12)} ${String(n).padStart(9)} records = file count ${bt.info.recordCount}` +
            `  (${table?.name}, ${table?.recordLength} bytes, ${bt.info.compressed ? 'compressed' : 'plain'}, ${((Date.now() - t1) / 1000).toFixed(1)} s)`,
        );
      } finally {
        await bt.close();
      }
    }
    if (args.includes('--books')) {
      const t1 = Date.now();
      const last = opt('--cutover');
      // Default: the day after the last entry, found by a first pass.
      const probe = last
        ? null
        : await readPeachtreeBooks(paths, {
            cutoverDate: '2999-12-31',
            openingDate: '2999-12-30',
            existingAccounts: DEFAULT_CHART_OF_ACCOUNTS,
            numbers: {
              customerAdvances:
                SYSTEM_ACCOUNT_DEFS.customer_advances.defaultNumber,
            },
          });
      const cutover = last ?? addDaysIso(probe!.source.lastEntryDate!, 1);
      const books = await readPeachtreeBooks(paths, {
        cutoverDate: cutover,
        openingDate: addDaysIso(cutover, -1),
        existingAccounts: DEFAULT_CHART_OF_ACCOUNTS,
        numbers: {
          customerAdvances: SYSTEM_ACCOUNT_DEFS.customer_advances.defaultNumber,
        },
      });
      console.log(
        `\nbooks read in ${((Date.now() - t1) / 1000).toFixed(1)} s:`,
        JSON.stringify(books.source),
      );
      console.log('\nchecks:');
      for (const c of books.checks)
        console.log(
          `  ${c.passed ? '✓' : '✗'} ${c.label} — expected ${c.expected}, actual ${c.actual}${c.passed ? '' : ' ' + JSON.stringify(c.details.slice(0, 5))}`,
        );
      console.log('\nfindings:');
      for (const f of books.findings)
        console.log(
          `  [${f.severity}${f.acceptable ? ', acceptable' : ''}] ${f.code}: ${f.message}`,
        );
      console.log('\nwarnings:');
      for (const w of books.warnings) console.log('  ' + w.slice(0, 400));
      console.log('\nsheets:');
      for (const g of books.grids)
        console.log(`  ${g.name}: ${g.rows.length - 1} rows`);
      const tb = books.grids.find((g) => g.name.startsWith('Trial Balance'))!;
      let dr = 0n,
        cr = 0n;
      const cents = (s: string | null) => (s ? BigInt(s.replace('.', '')) : 0n);
      for (const r of tb.rows.slice(1)) {
        dr += cents(r.cells[2]);
        cr += cents(r.cells[3]);
      }
      console.log(
        `  trial balance debits ${dr} credits ${cr} (paisa) — ${dr === cr ? 'balanced' : 'NOT balanced'}`,
      );
      for (const k of ['Open Invoices', 'Open Bills']) {
        const g = books.grids.find((x) => x.name.startsWith(k));
        if (!g) continue;
        let due = 0n;
        for (const r of g.rows.slice(1)) due += cents(r.cells[5]);
        console.log(
          `  ${k}: ${g.rows.length - 1} documents, amount due ${due} paisa`,
        );
      }
      console.log(
        `  stock: ${books.stock.items.length} items with quantity; inventory account ${books.stock.peachtreeAccount} → ${books.stock.inventoryAccount} ledger ${books.stock.ledgerBalance}`,
      );
      if (args.includes('--show'))
        for (const g of books.grids) {
          console.log(`\n== ${g.name}`);
          for (const r of g.rows) console.log('  ' + JSON.stringify(r.cells));
        }
    }
    const fieldsOf = opt('--fields');
    if (fieldsOf) {
      const table = dict.get(fieldsOf.toLowerCase());
      if (!table) throw new Error(`no table ${fieldsOf}`);
      console.log(
        [...table.fields.values()]
          .sort((a, b) => a.offset - b.offset)
          .filter(
            (f) =>
              !/Unused|DontUse|InternalUse|Yr|Budget|CustomField|Ship[0-9]|PriceLevel|SalesPrice[0-9]/i.test(
                f.name,
              ),
          )
          .map((f) => `${f.offset}:${f.name}/${f.type}/${f.size}`)
          .join('  '),
      );
    }
    const dump = opt('--dump');
    if (dump) {
      const table = dict.get(dump.toLowerCase());
      if (!table) throw new Error(`no table ${dump}`);
      const bt = await BtrieveFile.open(
        paths.get(table.file.toUpperCase())!,
        table.file,
      );
      const limit = Number(opt('--limit') ?? 3);
      let i = 0;
      for await (const rec of bt.records(table.recordLength)) {
        const out: Record<string, unknown> = {};
        for (const f of table.fields.values()) {
          try {
            const v = decodeField(rec, f);
            if (v !== '' && v !== 0 && v !== false && v !== null)
              out[f.name] = v;
          } catch (e) {
            out[f.name] = `!${(e as Error).message}`;
          }
        }
        console.log(JSON.stringify(out));
        if (++i >= limit) break;
      }
      await bt.close();
    }
  } finally {
    if (!args.includes('--keep'))
      await rm(work, { recursive: true, force: true });
    else console.log(`kept: ${work}`);
  }
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}

main().catch((e) => {
  console.error('FAILED:', e.code ?? '', e.message);
  process.exit(1);
});
