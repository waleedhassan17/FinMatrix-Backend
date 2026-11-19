import AdmZip from 'adm-zip';
import * as ExcelJS from 'exceljs';
import { readUpload } from './read-upload';

const xlsx = async () => {
  const wb = new ExcelJS.Workbook();
  wb.addWorksheet('Customers').addRow(['Name', 'Phone']);
  wb.getWorksheet('Customers')!.addRow(['Al-Noor', '0300']);
  wb.addWorksheet('Hidden', { state: 'hidden' }).addRow(['x']);
  return Buffer.from(await wb.xlsx.writeBuffer());
};

describe('readUpload', () => {
  it('reads visible sheets of an xlsx by its bytes, not its name', async () => {
    const r = await readUpload(await xlsx(), 'export.bin');
    expect(r.kind).toBe('xlsx');
    expect(r.sheets.map((s) => s.name)).toEqual(['Customers']);
    expect(r.sheets[0].rows[1].cells).toEqual(['Al-Noor', '0300']);
  });

  it('reads a CSV with a BOM and a ZIP of an xlsx plus a CSV', async () => {
    const csv = Buffer.from('﻿Name,City\nگلشن,ملتان\n', 'utf8');
    const r = await readUpload(csv, 'customers.csv');
    expect(r.kind).toBe('csv');
    expect(r.sheets[0].name).toBe('customers');
    expect(r.sheets[0].rows[1].cells).toEqual(['گلشن', 'ملتان']);

    const zip = new AdmZip();
    zip.addFile('books/Customers.xlsx', await xlsx());
    zip.addFile('books/vendors.csv', Buffer.from('Name\nKarachi Packaging\n'));
    const z = await readUpload(zip.toBuffer(), 'books.zip');
    expect(z.kind).toBe('zip');
    expect(z.sheets.map((s) => s.name).sort()).toEqual([
      'Customers/Customers',
      'vendors',
    ]);
  });

  it('keeps Tally XML as text for its profile', async () => {
    const r = await readUpload(
      Buffer.from('<ENVELOPE><BODY/></ENVELOPE>'),
      'tally.xml',
    );
    expect(r.kind).toBe('xml');
    expect(r.xml).toEqual(['<ENVELOPE><BODY/></ENVELOPE>']);
  });

  it('refuses old .xls, binaries and oversized files with the documented codes', async () => {
    const xls = Buffer.alloc(16);
    xls.writeUInt32BE(0xd0cf11e0, 0);
    await expect(readUpload(xls, 'old.xls')).rejects.toMatchObject({
      response: { code: 'MIGRATION_FILE_UNREADABLE' },
    });
    await expect(
      readUpload(Buffer.from([1, 0, 2, 0]), 'x.bin'),
    ).rejects.toMatchObject({
      response: { code: 'MIGRATION_FILE_UNREADABLE' },
    });
    await expect(
      readUpload(Buffer.alloc(2048, 65), 'big.csv', {
        maxBytes: 1024,
        maxRows: 10,
      }),
    ).rejects.toMatchObject({ response: { code: 'MIGRATION_FILE_TOO_LARGE' } });
  });
});

describe('readUpload: XML', () => {
  it('refuses an XML with a DOCTYPE, which no Tally export carries', async () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;">]><ENVELOPE>&lol2;</ENVELOPE>`;
    await expect(readUpload(Buffer.from(bomb), 'tally.xml')).rejects.toThrow(
      /DOCTYPE/,
    );
    const plain = `<?xml version="1.0"?><ENVELOPE><BODY>Ahmed &amp; Sons</BODY></ENVELOPE>`;
    const r = await readUpload(Buffer.from(plain), 'tally.xml');
    expect(r.kind).toBe('xml');
    expect(r.xml?.[0]).toContain('Ahmed &amp; Sons');
  });
});
