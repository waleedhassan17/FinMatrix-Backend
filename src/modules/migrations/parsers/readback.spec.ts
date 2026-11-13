import * as fs from 'fs';
import * as path from 'path';
import { parseAmount, parseQuantity } from './amount.parser';
import { parseDate } from './date.parser';
import {
  numberAsTyped,
  readbackAgrees,
  readbackAmount,
  readbackDate,
  readbackQuantity,
} from './readback';

const value = (t: unknown) => {
  const r = readbackAmount(t);
  return r.ok ? r.value : `ERR:${r.reason}`;
};

describe('readback: the second reader', () => {
  it('shares no code with the first reader', () => {
    const src = fs.readFileSync(path.join(__dirname, 'readback.ts'), 'utf8');
    const imports = src.match(/^import .*$/gm) ?? [];
    expect(imports.join('\n')).not.toMatch(
      /amount\.parser|date\.parser|text-normalize/,
    );
  });

  it('reads every form the first reader accepts, to the same value', () => {
    const corpus = [
      '1,20,000',
      '120,000',
      'Rs 1,20,000',
      'Rs. 1,20,000.50',
      'PKR 120000.50',
      '₨ 12,500/-',
      '120000.50',
      '1 250',
      '(1,200)',
      '-1200',
      '1200-',
      '(Rs 1,20,000.25)',
      '۱۲۰۰۰۰',
      '۱٬۲۰٬۰۰۰٫۵۰',
      '1,200 Dr',
      '1200 Cr',
      '12,00,000',
      '1,00,00,000',
      '0.0001',
      '123456789012.3456',
      '.5',
      '+450',
    ];
    for (const text of corpus) {
      const first = parseAmount(text);
      expect(first.ok).toBe(true);
      if (!first.ok || !first.amount) throw new Error(text);
      const v = readbackAgrees(
        'amount',
        first.amount.value,
        first.amount.side,
        text,
      );
      expect([text, v]).toEqual([text, { agrees: true, readback: v.readback }]);
    }
  });

  it('treats blank, a dash and null as no figure, like the first reader', () => {
    for (const t of ['', '  ', '-', '—', null, undefined]) {
      expect(value(t)).toBeNull();
      expect(readbackAgrees('amount', null, undefined, t).agrees).toBe(true);
    }
  });

  it('refuses a grouping that is not how a number is written', () => {
    // The first reader strips the commas and reads these; this one does not.
    for (const t of ['12,0000', '1,2,3', '1,234,56', '1,,200', ',200']) {
      expect(value(t)).toMatch(/^ERR:/);
      const first = parseAmount(t);
      if (first.ok && first.amount) {
        expect(
          readbackAgrees('amount', first.amount.value, first.amount.side, t)
            .agrees,
        ).toBe(false);
      }
    }
  });

  it('refuses words, a side that is not last, and a Dr/Cr on a quantity', () => {
    expect(value('1200 approx')).toMatch(/words/);
    expect(value('Dr 1200')).toMatch(/words/);
    expect(value('12 lakh')).toMatch(/words/);
    expect(readbackQuantity('12 Cr').ok).toBe(false);
    expect(parseQuantity('12 Cr').ok).toBe(false);
  });

  it('disagrees when the first reader stored a different value or side', () => {
    expect(
      readbackAgrees('amount', '12000', undefined, '1,20,000').agrees,
    ).toBe(false);
    expect(readbackAgrees('amount', '1200', 'credit', '1,200 Dr').agrees).toBe(
      false,
    );
    expect(readbackAgrees('amount', '1200', undefined, '1,200 Dr').agrees).toBe(
      false,
    );
    expect(readbackAgrees('amount', null, undefined, '1,200').agrees).toBe(
      false,
    );
    expect(readbackAgrees('amount', '1200', undefined, null).agrees).toBe(
      false,
    );
  });

  it('reads a number cell through its spreadsheet text', () => {
    expect(numberAsTyped(0.1 + 0.2)).toBe('0.3');
    expect(numberAsTyped(120000)).toBe('120000');
    expect(numberAsTyped(1e12)).toBe('1000000000000');
    const first = parseAmount(0.1 + 0.2);
    if (!first.ok || !first.amount) throw new Error('parse');
    expect(
      readbackAgrees(
        'amount',
        first.amount.value,
        undefined,
        numberAsTyped(0.1 + 0.2),
      ).agrees,
    ).toBe(true);
  });

  it('reads dates the first reader reads, to the same day', () => {
    const cases: Array<[string, 'dmy' | 'mdy' | undefined]> = [
      ['2026-06-30', undefined],
      ['2026/06/30', undefined],
      ['30/06/2026', 'dmy'],
      ['06/30/2026', 'mdy'],
      ['30-06-26', 'dmy'],
      ['30 Jun 2026', undefined],
      ['30 June 2026', undefined],
      ['Jun 30, 2026', undefined],
      ['Sept 5 2026', undefined],
      ['12/11/26', 'dmy'],
      ['46203', undefined],
      ['۳۰/۰۶/۲۰۲۶', 'dmy'],
    ];
    for (const [text, order] of cases) {
      const first = parseDate(text, order);
      expect([text, first.ok]).toEqual([text, true]);
      if (!first.ok) continue;
      const second = readbackDate(text, order);
      expect([text, second]).toEqual([text, { ok: true, iso: first.iso }]);
    }
    const serial = parseDate(46203);
    const back = readbackDate('46203');
    expect(serial.ok && back.ok && serial.iso === back.iso).toBe(true);
  });

  it('refuses an impossible date and an undecided day/month order', () => {
    expect(readbackDate('31/02/2026', 'dmy').ok).toBe(false);
    expect(readbackDate('12/11/2026').ok).toBe(false);
    expect(readbackDate('tomorrow').ok).toBe(false);
    expect(
      readbackAgrees('date', '2026-11-12', undefined, '12/11/2026', 'mdy')
        .agrees,
    ).toBe(false);
    expect(
      readbackAgrees('date', '2026-11-12', undefined, '12/11/2026', 'dmy')
        .agrees,
    ).toBe(true);
  });
});
