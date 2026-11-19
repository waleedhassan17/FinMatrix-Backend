import { parseAmount, parseQuantity } from './amount.parser';

const value = (v: unknown) => {
  const r = parseAmount(v);
  if (!r.ok) throw new Error(r.error);
  return r.amount?.value ?? null;
};

describe('parseAmount', () => {
  it('reads lakh and international grouping, currency words and decimals', () => {
    expect(value('1,20,000')).toBe('120000');
    expect(value('120,000')).toBe('120000');
    expect(value('Rs 1,20,000')).toBe('120000');
    expect(value('Rs. 1,20,000.50')).toBe('120000.5');
    expect(value('PKR 120000.50')).toBe('120000.5');
    expect(value('₨ 12,500/-')).toBe('12500');
    expect(value('120000.50')).toBe('120000.5');
    expect(value('1 250')).toBe('1250');
  });

  it('reads negatives as brackets, a leading or trailing minus', () => {
    expect(value('(1,200)')).toBe('-1200');
    expect(value('-1200')).toBe('-1200');
    expect(value('1200-')).toBe('-1200');
    expect(value('(Rs 1,20,000.25)')).toBe('-120000.25');
  });

  it('reads Urdu digits and Arabic separators', () => {
    expect(value('۱۲۰۰۰۰')).toBe('120000');
    expect(value('۱٬۲۰٬۰۰۰٫۵۰')).toBe('120000.5');
  });

  it('keeps a Dr/Cr suffix as the side', () => {
    expect(parseAmount('1,200 Dr')).toEqual({
      ok: true,
      amount: { value: '1200', side: 'debit' },
    });
    expect(parseAmount('1200 Cr')).toEqual({
      ok: true,
      amount: { value: '1200', side: 'credit' },
    });
    expect(parseQuantity('12 Cr').ok).toBe(false);
  });

  it('takes a number cell through toPrecision so float noise is gone', () => {
    expect(value(0.1 + 0.2)).toBe('0.3');
    expect(value(120000)).toBe('120000');
    expect(value(1e12)).toBe('1000000000000');
  });

  it('treats blank, a lone dash and null as no amount', () => {
    expect(value('')).toBeNull();
    expect(value('  ')).toBeNull();
    expect(value('-')).toBeNull();
    expect(value(null)).toBeNull();
    expect(value(undefined)).toBeNull();
  });

  it('refuses text, booleans, dates, and absurd sizes with a reason', () => {
    for (const bad of [
      'twelve',
      '12abc',
      true,
      new Date(),
      {},
      '1e99',
      '99999999999999',
    ]) {
      const r = parseAmount(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.length).toBeGreaterThan(5);
    }
  });

  it('never loses precision: the value is exactly what the file said', () => {
    expect(value('123456789012.3456')).toBe('123456789012.3456');
    expect(value('0.0001')).toBe('0.0001');
  });
});
