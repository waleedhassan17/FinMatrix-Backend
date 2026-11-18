import {
  CellError,
  NegativeValueError,
  cellToBoolean,
  cellToDecimal,
  cellToText,
  isBlankCell,
} from './cell-value';

describe('cell values', () => {
  describe('cellToText', () => {
    it('trims, and reads an empty cell as null', () => {
      expect(cellToText('  Sofa  ')).toBe('Sofa');
      expect(cellToText('   ')).toBeNull();
      expect(cellToText(null)).toBeNull();
      expect(cellToText(undefined)).toBeNull();
    });

    it('writes numbers plainly, never in exponent form', () => {
      expect(cellToText(1250)).toBe('1250');
      expect(cellToText(0.1 + 0.2)).toBe('0.3');
      expect(cellToText(123456789012345)).toBe('123456789012345');
    });

    it('unwraps rich text, hyperlinks and formula results', () => {
      expect(
        cellToText({ richText: [{ text: 'Walnut ' }, { text: 'chair' }] }),
      ).toBe('Walnut chair');
      expect(
        cellToText({ text: 'Catalogue', hyperlink: 'https://x.test' }),
      ).toBe('Catalogue');
      expect(cellToText({ formula: 'A1&B1', result: 'CHR-001' })).toBe(
        'CHR-001',
      );
      expect(cellToText({ sharedFormula: 'A2', result: 7 })).toBe('7');
    });

    it('explains a formula with no saved result and an error cell', () => {
      expect(() => cellToText({ formula: 'A1*2' })).toThrow(CellError);
      expect(() => cellToText({ formula: 'A1*2' })).toThrow(/no saved value/);
      expect(() => cellToText({ error: '#N/A' })).toThrow(/#N\/A/);
    });
  });

  describe('cellToDecimal', () => {
    it('reads numbers and the ways prices are typed', () => {
      expect(cellToDecimal(1250, 2)).toBe('1250');
      expect(cellToDecimal('1,250.50', 2)).toBe('1250.5');
      expect(cellToDecimal('Rs 1,250', 2)).toBe('1250');
      expect(cellToDecimal('PKR 99.9', 2)).toBe('99.9');
      expect(cellToDecimal(' ', 2)).toBeNull();
      expect(cellToDecimal(null, 2)).toBeNull();
    });

    it('removes Excel float noise before counting decimals', () => {
      // 0.1 + 0.2 = 0.30000000000000004 in a spreadsheet.
      expect(cellToDecimal(0.1 + 0.2, 2)).toBe('0.3');
      expect(cellToDecimal(8500.1 * 3, 4)).toBe('25500.3');
    });

    it('refuses what is not a usable amount', () => {
      expect(() => cellToDecimal('abc', 2)).toThrow(/not a number/);
      expect(() => cellToDecimal(-5, 2)).toThrow(/negative/);
      expect(() => cellToDecimal('12.345', 2)).toThrow(
        /at most 2 decimal places/,
      );
      expect(() => cellToDecimal(new Date(), 2)).toThrow(/date/);
      expect(() => cellToDecimal(true, 2)).toThrow(/TRUE\/FALSE/);
      expect(() => cellToDecimal(1e13, 2)).toThrow(/too large/);
    });

    it('treats negative zero as zero', () => {
      expect(cellToDecimal(-0, 2)).toBe('0');
    });

    it.each([
      '-',
      ' - ',
      '–',
      '—',
      '--',
      '---',
      'N/A',
      'n/a',
      'NA',
      'nil',
      'None',
      'null',
    ])('reads the placeholder %p as a blank cell', (placeholder) => {
      expect(cellToDecimal(placeholder, 4)).toBeNull();
    });

    it('reads amounts closed the Pakistani way', () => {
      expect(cellToDecimal('1250/-', 2)).toBe('1250');
      expect(cellToDecimal('Rs. 1,250/-', 2)).toBe('1250');
      expect(cellToDecimal('1250/=', 2)).toBe('1250');
      expect(cellToDecimal('Rs 1,250.50 /-', 2)).toBe('1250.5');
    });

    it('reads a unit after a quantity, only where the column allows it', () => {
      expect(cellToDecimal('12 pcs', 4, { unitSuffix: true })).toBe('12');
      expect(cellToDecimal('12pcs', 4, { unitSuffix: true })).toBe('12');
      expect(cellToDecimal('1,000 sets', 4, { unitSuffix: true })).toBe('1000');
      // A price never takes a unit: "12 pcs" in a price column is a mistake.
      expect(() => cellToDecimal('12 pcs', 2)).toThrow(/not a number/);
      expect(() => cellToDecimal('abc', 4, { unitSuffix: true })).toThrow(
        /"abc" is not a number/,
      );
    });

    it('tells a negative apart from an unreadable value', () => {
      expect(() => cellToDecimal(-5, 4)).toThrow(NegativeValueError);
      expect(() => cellToDecimal('(5)', 4)).toThrow(NegativeValueError);
      expect(() => cellToDecimal('abc', 4)).not.toThrow(NegativeValueError);
      try {
        cellToDecimal('(2.5)', 4);
      } catch (e) {
        expect((e as NegativeValueError).value).toBe('-2.5');
      }
    });
  });

  describe('cellToBoolean', () => {
    it('reads the yes/no words a sheet might hold', () => {
      for (const v of ['Yes', 'y', 'TRUE', '1', 'Active', true, 1])
        expect(cellToBoolean(v)).toBe(true);
      for (const v of ['No', 'n', 'false', '0', 'inactive', false, 0])
        expect(cellToBoolean(v)).toBe(false);
      expect(cellToBoolean('')).toBeNull();
      expect(() => cellToBoolean('maybe')).toThrow(/Yes or No/);
      expect(cellToBoolean('-')).toBeNull();
      expect(cellToBoolean('N/A')).toBeNull();
    });
  });

  it('isBlankCell sees through whitespace and empty rich text', () => {
    expect(isBlankCell('  ')).toBe(true);
    expect(isBlankCell({ richText: [{ text: ' ' }] })).toBe(true);
    expect(isBlankCell(0)).toBe(false);
    expect(isBlankCell('x')).toBe(false);
  });
});
