import {
  clampForXlsx,
  neutraliseFormula,
  serializeCell,
  serializeRow,
  XLSX_CELL_LIMIT,
} from './row-serializer';

describe('serializeCell', () => {
  it('writes money exactly as stored and never through a float', () => {
    expect(serializeCell('1234567.8900')).toBe('1234567.8900');
    expect(serializeCell('0.0001')).toBe('0.0001');
    expect(serializeCell('-15.5000')).toBe('-15.5000');
  });

  it('writes dates as ISO-8601 and empties for null', () => {
    expect(serializeCell(new Date(Date.UTC(2026, 10, 12, 9, 30)))).toBe(
      '2026-11-12T09:30:00.000Z',
    );
    expect(serializeCell('2026-11-12')).toBe('2026-11-12');
    expect(serializeCell(null)).toBe('');
    expect(serializeCell(undefined)).toBe('');
  });

  it('writes booleans, numbers, bigints, buffers and JSON', () => {
    expect(serializeCell(true)).toBe('true');
    expect(serializeCell(false)).toBe('false');
    expect(serializeCell(3)).toBe('3');
    expect(serializeCell(Number.NaN)).toBe('');
    expect(serializeCell(BigInt('9007199254740993'))).toBe('9007199254740993');
    expect(serializeCell(Buffer.from('hi'))).toBe('aGk=');
    expect(serializeCell({ street: 'Mall Rd', city: 'Lahore' })).toBe(
      '{"street":"Mall Rd","city":"Lahore"}',
    );
  });

  it('serializes a row in column order by property name', () => {
    const row = { id: 'a', balance: '10.0000', isActive: true, extra: 'no' };
    expect(
      serializeRow(row, [
        { property: 'id', header: 'id' },
        { property: 'isActive', header: 'is_active' },
        { property: 'balance', header: 'balance' },
      ]),
    ).toEqual(['a', 'true', '10.0000']);
  });

  it('clamps a cell for Excel but leaves shorter ones alone', () => {
    const long = 'x'.repeat(XLSX_CELL_LIMIT + 10);
    expect(clampForXlsx(long)).toHaveLength(XLSX_CELL_LIMIT);
    expect(clampForXlsx('short')).toBe('short');
  });
});

describe('backup cells never start a spreadsheet formula', () => {
  it('prefixes text that a spreadsheet would run', () => {
    expect(neutraliseFormula('=cmd|/c calc!A0')).toBe("'=cmd|/c calc!A0");
    expect(neutraliseFormula('+1+1')).toBe("'+1+1");
    expect(neutraliseFormula('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutraliseFormula('-2+3')).toBe("'-2+3");
    expect(neutraliseFormula('\tx')).toBe("'\tx");
  });

  it('leaves figures and ordinary text alone', () => {
    expect(neutraliseFormula('-1000.0000')).toBe('-1000.0000');
    expect(neutraliseFormula('+92')).toBe('+92');
    expect(neutraliseFormula('1200')).toBe('1200');
    expect(neutraliseFormula('Al-Noor Traders')).toBe('Al-Noor Traders');
    expect(neutraliseFormula('گلشن کریانہ')).toBe('گلشن کریانہ');
    expect(neutraliseFormula('')).toBe('');
  });

  it('applies to string cells only', () => {
    expect(serializeCell('=1+1')).toBe("'=1+1");
    expect(serializeCell(-5)).toBe('-5');
    expect(serializeCell('-5.2500')).toBe('-5.2500');
  });
});
