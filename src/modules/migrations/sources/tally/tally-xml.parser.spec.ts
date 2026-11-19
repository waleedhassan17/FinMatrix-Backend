import * as fs from 'fs';
import * as path from 'path';
import {
  parseTallyDocuments,
  tallyDate,
  tallyNumber,
} from './tally-xml.parser';

const FIX = path.join(
  __dirname,
  '../../../../../test/fixtures/migration/tally',
);
const docs = () =>
  [
    'tally-masters.xml',
    'tally-trial-balance.xml',
    'tally-bills-receivable.xml',
    'tally-bills-payable.xml',
    'tally-stock-summary.xml',
  ].map((f, i) => ({
    xml: fs.readFileSync(path.join(FIX, f), 'utf8'),
    fileIndex: i,
  }));
const sheet = (b: ReturnType<typeof parseTallyDocuments>, name: string) => {
  const g = b.grids.find((x) => x.name === name);
  if (!g) throw new Error(`no grid ${name}`);
  return g.rows.slice(1).map((r) => r.cells);
};

describe('tallyNumber / tallyDate', () => {
  it('reads Tally amounts, rates, quantities and dates', () => {
    expect(tallyNumber('-150000.00')).toBe('150000.00');
    expect(tallyNumber('-150000.00', { abs: false })).toBe('-150000.00');
    expect(tallyNumber('8500.00/pcs')).toBe('8500.00');
    expect(tallyNumber('12 pcs')).toBe('12');
    expect(tallyNumber('')).toBeNull();
    expect(tallyDate('20260415')).toBe('2026-04-15');
    expect(tallyDate('15-Apr-2026')).toBe('15-Apr-2026');
  });
});

describe('parseTallyDocuments', () => {
  const b = parseTallyDocuments(docs());

  it('finds all four exports and warns about nothing', () => {
    expect(b.found).toEqual({
      masters: true,
      trialBalance: true,
      bills: true,
      stock: true,
    });
    expect(b.warnings).toEqual([]);
  });

  it('maps ledgers to accounts by group, with reserved and generated numbers', () => {
    expect(sheet(b, 'Accounts (Tally)')).toEqual([
      ['1000', 'Cash', 'Asset', 'Cash', null],
      ['18001', 'Furniture & Fixtures', 'Asset', 'Fixed Asset', null],
      ['18002', 'Meezan Bank', 'Asset', 'Bank', null],
      ['38001', 'Owner Capital', 'Equity', 'Owner Equity', null],
      ['3100', 'Profit & Loss A/c', 'Equity', 'Retained Earnings', null],
      ['28001', 'Short-term Loan', 'Liability', 'Notes Payable', null],
    ]);
  });

  it('turns Sundry Debtors and Creditors (through user groups) into customers and vendors', () => {
    expect(
      sheet(b, 'Customers (Tally)').map((r) => [r[1], r[2], r[6], r[7], r[8]]),
    ).toEqual([
      ['Al-Noor Traders', '0300-1234567', '30 Days', '500000.00', '1234567-8'],
      ['Bismillah Store', '0321-7654321', '15 Days', null, null],
      ['Raza & Sons', null, null, null, null],
      ['گلشن کریانہ', null, null, null, null],
    ]);
    expect(sheet(b, 'Vendors (Tally)').map((r) => r[1])).toEqual([
      'Karachi Packaging',
      'Lahore Mills',
    ]);
  });

  it('routes party balances to the control accounts and skips the group subtotal', () => {
    const tb = sheet(b, 'Trial Balance (Tally)');
    expect(tb.find((r) => r[1] === 'Sundry Debtors')).toBeUndefined();
    expect(tb.filter((r) => r[0] === '1100').map((r) => r[2])).toEqual([
      '165000.00',
      '50000.00',
      '30000.00',
    ]);
    expect(tb.filter((r) => r[0] === '2000').map((r) => r[3])).toEqual([
      '123250.00',
      '40000.00',
    ]);
    expect(tb.find((r) => r[1] === 'Closing Stock')![0]).toBe('1200');
    const cents = (v: unknown) => (v ? Math.round(Number(v) * 100) : 0);
    expect(tb.reduce((s, r) => s + cents(r[2]), 0)).toBe(109250050);
    expect(tb.reduce((s, r) => s + cents(r[3]), 0)).toBe(109250050);
  });

  it('splits bill-wise outstanding into open invoices and open bills by party', () => {
    expect(
      sheet(b, 'Open Invoices (Tally)').map((r) => [r[0], r[1], r[2], r[5]]),
    ).toEqual([
      ['Al-Noor Traders', 'INV-1001', '15-Apr-2026', '120000.00'],
      ['Al-Noor Traders', 'INV-1002', '20-May-2026', '45000.00'],
      ['Bismillah Store', 'INV-1003', '28-May-2026', '50000.00'],
      ['گلشن کریانہ', 'INV-1004', '13-Jun-2026', '30000.00'],
    ]);
    expect(sheet(b, 'Open Bills (Tally)').map((r) => r[1])).toEqual([
      'KP-7781',
      'KP-7790',
      'LM-301',
    ]);
  });

  it('reads stock by part number and skips stock-group subtotals', () => {
    expect(sheet(b, 'Stock (Tally)')).toEqual([
      ['CHR-001', '12', '8500.00'],
      ['TBL-001', '2', '25000.00'],
      ['CUS-001', '24', '1250.00'],
    ]);
    expect(
      sheet(b, 'Items (Tally)').map((r) => [r[0], r[3], r[4], r[5]]),
    ).toEqual([
      ['CHR-001', 'pcs', '8500.00', '12500.00'],
      ['TBL-001', 'pcs', '25000.00', '38000.00'],
      ['CUS-001', 'pcs', '1250.00', '2000.00'],
    ]);
  });

  it('says what is missing when the masters export is not there', () => {
    const noMasters = parseTallyDocuments(docs().slice(1));
    expect(noMasters.found.masters).toBe(false);
    expect(noMasters.warnings[0]).toMatch(/masters/i);
  });
});
