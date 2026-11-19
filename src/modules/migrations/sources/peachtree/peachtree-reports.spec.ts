import { SourceGrid } from '../../readers/read-upload';
import { assignCodes, distinctNames, partyCodeForm } from './peachtree-books';
import {
  detectPeachtreeReport,
  parsePeachtreeReport,
} from './peachtree-reports';
import { pairByKey } from './peachtree-sheets';

const sheet = (name: string, rows: unknown[][]): SourceGrid => ({
  name,
  rows: rows.map((cells, i) => ({ rowNumber: i + 1, cells: cells as any[] })),
});

const title = (t: string, asOf = 'As of Oct 5, 2026') => [
  ['Indus Valley Distributors'],
  [t],
  [asOf],
  ['Filter Criteria includes: Report order is by ID.'],
];

describe('Peachtree report exports', () => {
  it('reads a General Ledger Trial Balance, debits positive, credits negative', () => {
    const g = sheet('Trial Balance', [
      ...title('General Ledger Trial Balance'),
      ['Account ID', 'Account Description', 'Debit Amt', 'Credit Amt'],
      ['10100', 'Cash on Hand', 1500.5, null],
      ['20000', 'Accounts Payable', null, '2,000.00'],
      ['40000', 'Sales', null, 3000],
      ['', 'Total:', 1500.5, 5000],
    ]);
    const layout = detectPeachtreeReport(g)!;
    expect(layout.kind).toBe('trial_balance');
    const r = parsePeachtreeReport(g, layout);
    expect(r.asOf).toBe('2026-10-05');
    expect(r.lines.map((l) => [l.key, l.amount])).toEqual([
      ['10100', '1500.50'],
      ['20000', '-2000.00'],
      ['40000', '-3000.00'],
    ]);
    expect(r.problems).toEqual([]);
  });

  it('adds up an aged report by party from its document lines only, never its totals', () => {
    const g = sheet('Aged Receivables', [
      ...title('Aged Receivables', 'As of 10/5/26'),
      [
        'Customer ID',
        'Customer',
        'Invoice/CM #',
        'Date',
        '0 - 30',
        '31 - 60',
        'Amount Due',
      ],
      ['C001', 'Madina Karyana', null, null, null, null, null],
      [null, null, '1001', '2026-09-01', 1000, null, 1000],
      [null, null, '1002', '2026-08-01', null, 250.25, 250.25],
      [null, 'C001 Total', null, null, 1000, 250.25, 1250.25],
      [
        'c001',
        'madina karyana (lower-case ID: another customer)',
        null,
        null,
        null,
        null,
        null,
      ],
      [null, null, 'CM7', '2026-09-20', -100, null, -100],
      [null, 'Report Total', null, null, null, null, 1150.25],
    ]);
    const layout = detectPeachtreeReport(g)!;
    expect(layout.kind).toBe('aged_receivables');
    const r = parsePeachtreeReport(g, layout);
    expect(r.asOf).toBe('2026-10-05');
    expect(r.lines.map((l) => [l.key, l.amount, l.documents])).toEqual([
      ['C001', '1250.25', 2],
      ['c001', '-100.00', 1],
    ]);
  });

  it('reads an Inventory Valuation Report: quantity and value per item', () => {
    const g = sheet('Inventory Valuation', [
      ...title('Inventory Valuation Report'),
      [
        'Item ID',
        'Item Description',
        'Stocking U/M',
        'Cost Method',
        'Qty on Hand',
        'Item Value',
        'Avg Cost',
      ],
      ['GHEE-1', 'Ghee 1kg', 'Each', 'Average', 12, 4800, 400],
      ['RICE', 'Rice', 'Kg', 'Average', 0.5, 75.5, 151],
    ]);
    const r = parsePeachtreeReport(g, detectPeachtreeReport(g)!);
    expect(r.kind).toBe('inventory_valuation');
    expect(r.lines.map((l) => [l.key, l.quantity, l.amount])).toEqual([
      ['GHEE-1', '12', '4800.00'],
      ['RICE', '0.5', '75.50'],
    ]);
  });

  it('is not fooled by an ordinary spreadsheet', () => {
    expect(
      detectPeachtreeReport(
        sheet('Customers', [
          ['Name', 'Phone'],
          ['A', '1'],
        ]),
      ),
    ).toBeNull();
  });

  it('lists a cell it cannot read instead of guessing', () => {
    const g = sheet('TB', [
      ['Account ID', 'Account Description', 'Debit Amt', 'Credit Amt'],
      ['10100', 'Cash', 'twelve', null],
    ]);
    const r = parsePeachtreeReport(g, detectPeachtreeReport(g)!);
    expect(r.problems).toHaveLength(1);
    expect(r.problems[0]).toMatch(/row 2: debit "twelve"/);
  });
});

describe('pairByKey', () => {
  const b = (key: string) => ({ key });
  it('pairs exactly first: IDs that differ only in capitals are different parties', () => {
    const backup = [b('C001'), b('c001')];
    const lines = [b('c001'), b('C001')];
    const m = pairByKey(backup, lines);
    expect(m.get(backup[0])).toBe(lines[1]);
    expect(m.get(backup[1])).toBe(lines[0]);
  });

  it('falls back to capitals and dropped leading zeros only when unambiguous', () => {
    const backup = [b('00123'), b('abc'), b('X1'), b('x1 ')];
    const lines = [b('123'), b('ABC'), b('X1 ')];
    const m = pairByKey(backup, lines);
    expect(m.get(backup[0])).toBe(lines[0]);
    expect(m.get(backup[1])).toBe(lines[1]);
    // "X1" and "x1 " both loosely equal "X1 ": ambiguous, neither is paired.
    expect(m.has(backup[2])).toBe(false);
    expect(m.has(backup[3])).toBe(false);
  });
});

describe('FinMatrix codes and names for Peachtree IDs', () => {
  it('turns an ID into a valid FinMatrix party ID', () => {
    expect(partyCodeForm('GHRD015')).toBe('GHRD015');
    expect(partyCodeForm('Gala mandi11')).toBe('GALA-MANDI11');
    expect(partyCodeForm('  -x/y ')).toBe('X/Y');
    expect(partyCodeForm('A VERY LONG CUSTOMER ID 123')).toHaveLength(20);
  });

  it('keeps codes apart where FinMatrix would see one, and says which changed', () => {
    const parties = [
      { id: 'KASHIF KARYANA' },
      { id: 'Kashif Karyana' },
      { id: 'KASHIF-KARYANA-2' },
      { id: 'C1' },
    ];
    const codes = new Map<string, string>();
    const changed = assignCodes(
      parties,
      (p) => p.id,
      partyCodeForm,
      20,
      (p, c) => codes.set(p.id, c),
    );
    expect(parties.map((p) => codes.get(p.id))).toEqual([
      'KASHIF-KARYANA',
      'KASHIF-KARYANA-2',
      'KASHIF-KARYANA-2-2',
      'C1',
    ]);
    expect(changed.map((c) => c.id)).toEqual([
      'KASHIF KARYANA',
      'Kashif Karyana',
      'KASHIF-KARYANA-2',
    ]);
  });

  it('gives each of a repeated name its code, never in brackets (which matching ignores)', () => {
    const xs = [
      { name: 'Madina Karyana', code: 'GHRD015' },
      { name: 'MADINA  KARYANA', code: 'GHRD102' },
      { name: 'Bismillah Store', code: 'B1' },
      { name: 'Bismillah Store - B2', code: 'B9' },
      { name: 'Bismillah store', code: 'B2' },
    ];
    distinctNames(
      xs,
      (x) => x.code,
      (x, n) => (x.name = n),
    );
    expect(xs.map((x) => x.name)).toEqual([
      'Madina Karyana - GHRD015',
      'MADINA  KARYANA - GHRD102',
      'Bismillah Store - B1',
      'Bismillah Store - B2',
      'Bismillah store - B2 2',
    ]);
  });
});
