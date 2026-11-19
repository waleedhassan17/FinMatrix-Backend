import * as ExcelJS from 'exceljs';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { readXlsxLean } from './xlsx-lean';

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'xlsx-lean-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function workbook(path: string, sharedStrings: boolean) {
  const wb = new ExcelJS.stream.xlsx.WorkbookWriter({ filename: path, useSharedStrings: sharedStrings });
  const keep = wb.addWorksheet('Keep & Read');
  keep.addRow(['Account', 'Debit', 'Credit']).commit();
  keep.addRow(['Cash <in> hand & "petty"', 1500.25, null]).commit();
  const r = keep.addRow(['Sales']);
  r.getCell(3).value = 1500.25; // B left empty
  r.commit();
  keep.addRow(['Flag', true, 'x']).commit();
  keep.commit();
  const skip = wb.addWorksheet('Ledger');
  skip.addRow(['Date', 'Memo', 'Amount']).commit();
  for (let i = 0; i < 5000; i++) skip.addRow(['2026-09-01', `memo ${i}`, i]).commit();
  skip.commit();
  const hidden = wb.addWorksheet('Hidden', { state: 'hidden' });
  hidden.addRow(['secret']).commit();
  hidden.commit();
  await wb.commit();
}

describe('readXlsxLean', () => {
  it.each([true, false])('reads kept sheets exactly (shared strings: %s) and stops skipped ones at their first rows', async (shared) => {
    const path = join(dir, `book-${shared}.xlsx`);
    await workbook(path, shared);
    const judged: Array<{ name: string; rows: number }> = [];
    const out = await readXlsxLean(path, 'Export', {
      headRows: 10,
      maxRows: 100_000,
      judge: (g) => {
        judged.push({ name: g.name, rows: g.rows.length });
        return g.name.endsWith('Keep & Read') ? { keep: true, reason: '' } : { keep: false, reason: 'a ledger' };
      },
    });
    expect(out.sheets.map((s) => s.name)).toEqual(['Export/Keep & Read']);
    expect(out.sheets[0].rows.map((r) => r.cells)).toEqual([
      ['Account', 'Debit', 'Credit'],
      ['Cash <in> hand & "petty"', 1500.25],
      ['Sales', null, 1500.25],
      ['Flag', true, 'x'],
    ]);
    expect(out.skipped).toEqual([{ entry: 'Export/Ledger', reason: 'a ledger' }]);
    // The ledger was judged on its first rows only; the hidden sheet not at all.
    expect(judged.find((j) => j.name === 'Export/Ledger')?.rows).toBe(10);
    expect(judged.some((j) => j.name.endsWith('Hidden'))).toBe(false);
  });

  it('a kept sheet longer than the limit is skipped as a ledger, not loaded', async () => {
    const path = join(dir, 'long.xlsx');
    await workbook(path, true);
    const out = await readXlsxLean(path, 'Export', { headRows: 10, maxRows: 100, judge: () => ({ keep: true, reason: '' }) });
    expect(out.sheets.map((s) => s.name)).toEqual(['Export/Keep & Read']);
    expect(out.skipped[0].reason).toMatch(/over 100 rows/);
  });
});
