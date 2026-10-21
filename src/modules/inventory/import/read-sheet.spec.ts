import * as ExcelJS from 'exceljs';
import { parseCsv, readImportFile } from './read-sheet';
import { MAX_IMPORT_ROWS } from './import-columns';

const xlsx = async (build: (wb: ExcelJS.Workbook) => void) => {
  const wb = new ExcelJS.Workbook();
  build(wb);
  return Buffer.from(await wb.xlsx.writeBuffer());
};

describe('readImportFile', () => {
  it('reads an .xlsx by header name, whatever the column order', async () => {
    const buf = await xlsx((wb) => {
      const ws = wb.addWorksheet('Items');
      ws.addRow(['Selling Price', 'Name', 'sku', 'Colour']);
      ws.addRow([12500, 'Dining chair', 'CHR-001', 'Walnut']);
    });
    const sheet = await readImportFile(buf);
    expect(sheet.sheetName).toBe('Items');
    expect(sheet.recognized).toEqual(['Selling Price', 'Name', 'sku']);
    expect(sheet.ignored).toEqual(['Colour']);
    expect(sheet.rows).toEqual([
      { rowNumber: 2, cells: { sellingPrice: 12500, name: 'Dining chair', sku: 'CHR-001' } },
    ]);
  });

  it('finds the header below a title line, and the sheet that has it', async () => {
    const buf = await xlsx((wb) => {
      wb.addWorksheet('Notes').addRow(['Nothing here']);
      const ws = wb.addWorksheet('Stock list');
      ws.addRow(['Galaxy Interiors — price list']);
      ws.addRow([]);
      ws.addRow(['Item code', 'Item name']);
      ws.addRow(['SOF-3', 'Three-seater sofa']);
    });
    const sheet = await readImportFile(buf);
    expect(sheet.sheetName).toBe('Stock list');
    // Row numbers are the ones the user sees in Excel.
    expect(sheet.rows[0]).toEqual({ rowNumber: 4, cells: { sku: 'SOF-3', name: 'Three-seater sofa' } });
  });

  it('skips blank rows and ignores the read-only On hand column', async () => {
    const buf = await xlsx((wb) => {
      const ws = wb.addWorksheet('Items');
      ws.addRow(['SKU', 'Name', 'On hand (read-only)']);
      ws.addRow(['A', 'First', 5]);
      ws.addRow(['', '', '']);
      ws.addRow(['B', 'Second', 9]);
    });
    const sheet = await readImportFile(buf);
    expect(sheet.ignored).toEqual(['On hand (read-only)']);
    expect(sheet.rows.map((r) => r.rowNumber)).toEqual([2, 4]);
    expect(sheet.rows[0].cells).toEqual({ sku: 'A', name: 'First' });
  });

  it('reads a CSV as text, so leading zeros survive', async () => {
    const sheet = await readImportFile(Buffer.from('﻿SKU,Name,Unit cost\r\n00123,"Lamp, brass",450\r\n'));
    expect(sheet.sheetName).toBe('CSV');
    expect(sheet.rows[0].cells).toEqual({ sku: '00123', name: 'Lamp, brass', unitCost: '450' });
  });

  it('refuses an old .xls with instructions to re-save it', async () => {
    const xls = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
    await expect(readImportFile(xls)).rejects.toMatchObject({
      status: 415,
      response: { code: 'IMPORT_UNSUPPORTED_FILE', message: expect.stringContaining('.xlsx') },
    });
  });

  it('explains a file with no SKU column, or no rows', async () => {
    await expect(readImportFile(Buffer.from('Name,Price\nChair,10\n'))).rejects.toMatchObject({
      response: { code: 'IMPORT_NO_HEADER' },
    });
    await expect(readImportFile(Buffer.from('SKU,Name\n'))).rejects.toMatchObject({
      response: { code: 'IMPORT_EMPTY' },
    });
  });

  it(`stops at ${MAX_IMPORT_ROWS} items`, async () => {
    const lines = ['SKU,Name', ...Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `S${i},Item ${i}`)];
    await expect(readImportFile(Buffer.from(lines.join('\n')))).rejects.toMatchObject({
      response: { code: 'IMPORT_TOO_MANY_ROWS' },
    });
    await expect(readImportFile(Buffer.from(lines.slice(0, -1).join('\n')))).resolves.toBeDefined();
  });

  it('refuses a damaged workbook instead of crashing', async () => {
    const broken = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64)]);
    await expect(readImportFile(broken)).rejects.toMatchObject({ response: { code: 'IMPORT_UNREADABLE' } });
  });
});

describe('parseCsv', () => {
  it('handles quotes, escaped quotes and newlines inside a field', () => {
    const grid = parseCsv('SKU,Name\nA,"Say ""hi""\nthere"\nB,Plain\n');
    expect(grid.map((r) => r.values)).toEqual([
      ['SKU', 'Name'],
      ['A', 'Say "hi"\nthere'],
      ['B', 'Plain'],
    ]);
  });

  it('sniffs a semicolon delimiter, as Excel writes in decimal-comma locales', () => {
    expect(parseCsv('SKU;Name\nA;Chair').map((r) => r.values)).toEqual([
      ['SKU', 'Name'],
      ['A', 'Chair'],
    ]);
  });
});
