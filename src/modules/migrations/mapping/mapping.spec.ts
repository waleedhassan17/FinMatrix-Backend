import { mapColumns, missingFields } from './column-mapper';
import { normalizeRows } from './normalize-rows';
import { detectSheet } from './sheet-detector';
import { mapEnumValue } from './value-mapper';
import { targetSheet } from '../targets';

const grid = (header: string[], ...rows: unknown[][]) =>
  [header, ...rows].map((cells, i) => ({ rowNumber: i + 1, cells }));

describe('detectSheet', () => {
  it('recognises the starter workbook sheets by name with certainty', () => {
    const d = detectSheet(
      'Open Invoices',
      grid([
        'Customer code or name',
        'Invoice number',
        'Invoice date',
        'Due date',
        'Original amount',
        'Amount due',
      ]),
    );
    expect(d.target).toBe('open_invoices');
    expect(d.confidence).toBe(1);
    expect(d.headerRowIndex).toBe(0);
  });

  it('recognises a messy export by its headers, with a title row above them', () => {
    const d = detectSheet(
      'Sheet1',
      grid(
        ['Al-Noor Traders — Receivables as at 30 June'],
        [],
        [
          'Party Name',
          'Inv No',
          'Inv Date',
          'Due',
          'Bill Amount',
          'Balance Due',
        ],
        ['ABC', 'INV-1', '12/11/2026', '', '1,20,000', '45,000'],
      ),
    );
    expect(d.target).toBe('open_invoices');
    expect(d.headerRowIndex).toBe(2);
    expect(d.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('reads Roman Urdu and Urdu sheet names', () => {
    expect(
      detectSheet('gahak', grid(['Name', 'Phone', 'Credit limit'])).target,
    ).toBe('customers');
    expect(detectSheet('سپلائر', grid(['نام', 'فون'])).target).toBe('vendors');
  });

  it('asks rather than guesses between Customers and Vendors for a nameless party list', () => {
    const d = detectSheet('Parties', grid(['Name', 'Phone', 'Email', 'City']));
    expect(d.confidence).toBeLessThan(0.9);
    expect([d.target, ...d.alternatives.map((a) => a.target)]).toEqual(
      expect.arrayContaining(['customers', 'vendors']),
    );
  });

  it('ignores read-me style sheets and sheets with no header', () => {
    expect(detectSheet('Read me', grid(['Moving to FinMatrix'])).reason).toBe(
      'noise',
    );
    expect(detectSheet('Chart', grid(['a', 'b'], [1, 2])).target).toBeNull();
  });
});

describe('mapColumns', () => {
  const target = targetSheet('open_invoices');

  it('maps exact headers and synonyms with full confidence', () => {
    const p = mapColumns(
      ['Party', 'Invoice No', 'Date', 'Amount', 'Outstanding'],
      target,
    );
    expect(p.map((x) => [x.field, x.confidence])).toEqual([
      ['customer', 1],
      ['invoiceNumber', 1],
      ['invoiceDate', 1],
      ['originalAmount', 1],
      ['amountDue', 1],
    ]);
  });

  it('proposes near-misses below the confidence bar and leaves junk unmapped', () => {
    const p = mapColumns(
      ['Name of Customer', 'Invioce Number', 'Colour'],
      target,
    );
    expect(p[0]).toMatchObject({ field: 'customer', confidence: 0.85 });
    // A parenthetical note is not part of the header.
    expect(mapColumns(['Customer Name (as per NTN)'], target)[0]).toMatchObject(
      { field: 'customer', confidence: 1 },
    );
    expect(p[1]).toMatchObject({ field: 'invoiceNumber', confidence: 0.75 });
    expect(p[2]).toMatchObject({ field: null, confidence: 0 });
  });

  it('prefers a saved profile and keeps one field per column', () => {
    const p = mapColumns(['Ref', 'Reference'], target, {
      ref: 'invoiceNumber',
    });
    expect(p[0]).toMatchObject({
      field: 'invoiceNumber',
      origin: 'profile',
      confidence: 1,
    });
    expect(p[1].field).toBeNull();
    expect(missingFields(target, p).required.map((f) => f.key)).toEqual([
      'customer',
      'invoiceDate',
      'originalAmount',
      'amountDue',
    ]);
  });
});

describe('mapEnumValue', () => {
  it('maps account types across English, Tally groups, Roman Urdu and Urdu', () => {
    expect(mapEnumValue('type', 'Asset').value).toBe('asset');
    expect(mapEnumValue('type', 'Sundry Debtors').value).toBe('asset');
    expect(mapEnumValue('type', 'Duties & Taxes').value).toBe('liability');
    expect(mapEnumValue('type', 'Capital Account').value).toBe('equity');
    expect(mapEnumValue('type', 'Indirect Incomes').value).toBe('revenue');
    expect(mapEnumValue('type', 'kharcha').value).toBe('expense');
    expect(mapEnumValue('type', 'اثاثے').value).toBe('asset');
    expect(mapEnumValue('paymentTerms', '30 days').value).toBe('net30');
    expect(mapEnumValue('paymentTerms', 'نقد').value).toBe('due_on_receipt');
  });

  it('never silently defaults an unknown value', () => {
    const r = mapEnumValue('type', 'Miscellaneous');
    expect(r.value).toBeNull();
    expect(r.confidence).toBe(0);
  });
});

describe('normalizeRows', () => {
  const target = targetSheet('open_invoices');
  const columns = mapColumns(
    ['Customer', 'Invoice No', 'Invoice Date', 'Due Date', 'Amount', 'Balance'],
    target,
  );
  const mapValue = (field: string, raw: unknown) =>
    mapEnumValue(field, raw).value;

  it('parses amounts and dates, skips template rows, hashes raw rows', () => {
    const rows = grid(
      [
        'Customer',
        'Invoice No',
        'Invoice Date',
        'Due Date',
        'Amount',
        'Balance',
      ],
      ['HOW TO FILL: the customer', 'x', 'x', 'x', 'x', 'x'],
      ['EXAMPLE C-0001', 'INV-1', '15/09/2026', '', '120000', '45000'],
      [
        'Al-Noor',
        'INV-2451',
        '25/09/2026',
        '25/10/2026',
        'Rs 1,20,000',
        '(45,000)',
      ],
      [null, null, null, null, null, null],
    );
    const r = normalizeRows(target, rows, 0, columns, { mapValue });
    expect(r.skippedTemplateRows).toBe(2);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].normalized).toEqual({
      customer: 'Al-Noor',
      invoiceNumber: 'INV-2451',
      invoiceDate: '2026-09-25',
      invoiceDateText: '25/09/2026',
      invoiceDateOrder: 'dmy',
      dueDate: '2026-10-25',
      dueDateText: '25/10/2026',
      dueDateOrder: 'dmy',
      originalAmount: '120000',
      originalAmountText: 'Rs 1,20,000',
      amountDue: '-45000',
      amountDueText: '(45,000)',
    });
    expect(r.rows[0].errors).toEqual([]);
    expect(r.rows[0].rowHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('reports an ambiguous date column once per field and keeps the rows waiting', () => {
    const rows = grid(
      [
        'Customer',
        'Invoice No',
        'Invoice Date',
        'Due Date',
        'Amount',
        'Balance',
      ],
      ['A', 'I-1', '03/04/2026', '', '10', '10'],
      ['B', 'I-2', '05/06/2026', '', '10', '10'],
    );
    const r = normalizeRows(target, rows, 0, columns, { mapValue });
    expect(r.ambiguousDateFields).toEqual(['invoiceDate']);
    expect(
      r.rows.every((x) =>
        x.errors.some((e) => e.code === 'AMBIGUOUS_DATE_FORMAT'),
      ),
    ).toBe(true);
    const fixed = normalizeRows(target, rows, 0, columns, {
      mapValue,
      dateOrder: { invoiceDate: 'dmy' },
    });
    expect(fixed.ambiguousDateFields).toEqual([]);
    expect(fixed.rows[0].normalized.invoiceDate).toBe('2026-04-03');
  });

  it('flags bad amounts, bad dates and blank required cells with the field', () => {
    const rows = grid(
      [
        'Customer',
        'Invoice No',
        'Invoice Date',
        'Due Date',
        'Amount',
        'Balance',
      ],
      ['', 'I-1', 'yesterday', '', 'twelve', '10'],
    );
    const r = normalizeRows(target, rows, 0, columns, { mapValue });
    const codes = r.rows[0].errors.map((e) => `${e.field}:${e.code}`);
    expect(codes).toEqual(
      expect.arrayContaining([
        'customer:MISSING_REQUIRED_VALUE',
        'invoiceDate:INVALID_DATE',
        'originalAmount:INVALID_AMOUNT',
      ]),
    );
  });

  it('moves a negative or Cr-suffixed trial balance debit to the credit side', () => {
    const tb = targetSheet('trial_balance');
    const cols = mapColumns(
      ['Account number', 'Account name', 'Debit', 'Credit'],
      tb,
    );
    const rows = grid(
      ['Account number', 'Account name', 'Debit', 'Credit'],
      ['1000', 'Cash', '1,20,000', ''],
      ['2000', 'Payables', '-30,000', ''],
      ['3000', 'Capital', '90,000 Cr', ''],
    );
    const r = normalizeRows(tb, rows, 0, cols, { mapValue });
    expect(
      r.rows.map((x) => [x.normalized.debit, x.normalized.credit]),
    ).toEqual([
      ['120000', null],
      [null, '30000'],
      [null, '90000'],
    ]);
  });
});
