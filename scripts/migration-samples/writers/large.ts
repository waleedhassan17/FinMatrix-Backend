/**
 * Large samples: the same books inside exports a business with years of
 * history produces — the small reports a migration needs beside a general
 * ledger and journal of millions of lines that it must skip, without
 * holding them in memory. Written with streaming writers (and shared
 * strings, as Excel writes them) straight to disk.
 */
import AdmZip from 'adm-zip';
import * as ExcelJS from 'exceljs';
import { createWriteStream } from 'fs';
import { mkdtemp, readFile, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import archiver from 'archiver';
import { fmtDate, SampleBooks } from '../books';
import { quickbooksOnline } from './quickbooks';

/** A QuickBooks ledger-shaped workbook of `rows` lines, streamed to `path`. */
async function ledgerWorkbook(path: string, title: string, rows: number, b: SampleBooks) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: path, useSharedStrings: true, useStyles: false });
  const ws = wb.addWorksheet(title);
  ws.addRow([b.company]).commit();
  ws.addRow([title]).commit();
  ws.addRow(['July 1, 2019 - September 30, 2026']).commit();
  ws.addRow([]).commit();
  ws.addRow(['', 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Split', 'Amount', 'Balance']).commit();
  const types = ['Invoice', 'Payment', 'Bill', 'Bill Payment (Check)', 'Deposit', 'Journal Entry', 'Sales Receipt', 'Expense'];
  const parties = [...b.customers, ...b.vendors].map((p) => p.name);
  let balance = 0;
  for (let i = 0; i < rows; i++) {
    const d = new Date(Date.UTC(2019, 6, 1) + (i % 2650) * 86400000).toISOString().slice(0, 10);
    const amount = ((i * 7919) % 250000) / 100 + 10;
    balance += i % 2 ? amount : -amount;
    ws.addRow(['', fmtDate.mdy(d), types[i % types.length], 100000 + i, parties[i % parties.length], `Line ${i % 5000} — goods as per challan`, 'Accounts Receivable (A/R)', amount, Math.round(balance * 100) / 100]).commit();
  }
  ws.commit();
  await wb.commit();
}

/** A ZIP written by streaming, entries stored (the workbooks are already compressed). */
async function zipTo(path: string, entries: Array<{ name: string; file?: string; buffer?: Buffer }>) {
  await new Promise<void>((resolve, reject) => {
    const out = createWriteStream(path);
    const zip = archiver('zip', { store: true });
    out.on('close', () => resolve());
    zip.on('error', reject);
    zip.pipe(out);
    for (const e of entries) {
      if (e.file) zip.file(e.file, { name: e.name });
      else zip.append(e.buffer!, { name: e.name });
    }
    void zip.finalize();
  });
}

/**
 * "QuickBooks Online - Export data (large).zip": trial balance, customers and
 * vendors, plus a general ledger and a journal of `ledgerRows` lines each.
 * Returns the ZIP path and the other reports to upload beside it.
 */
export async function largeQuickbooksExport(b: SampleBooks, outPath: string, ledgerRows: number) {
  const work = await mkdtemp(join(tmpdir(), 'fm-large-'));
  try {
    const small = await quickbooksOnline(b);
    const inner = new AdmZip(small['QuickBooks Online - Export data.zip']);
    const keep = ['Trial_balance.xlsx', 'Customers.xlsx', 'Vendors.xlsx', 'Profit_and_loss.xlsx', 'Balance_sheet.xlsx'];
    const gl = join(work, 'General_ledger.xlsx');
    const journal = join(work, 'Journal.xlsx');
    await ledgerWorkbook(gl, 'General Ledger', ledgerRows, b);
    await ledgerWorkbook(journal, 'Journal', ledgerRows, b);
    await zipTo(outPath, [
      ...keep.map((n) => ({ name: n, buffer: inner.getEntry(n)!.getData() })),
      { name: 'General_ledger.xlsx', file: gl },
      { name: 'Journal.xlsx', file: journal },
    ]);
    const others = Object.fromEntries(Object.entries(small).filter(([n]) => !n.endsWith('.zip')));
    return { zip: outPath, size: (await stat(outPath)).size, others };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export { readFile };
