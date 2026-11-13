import { detectDateOrder, parseDate } from './date.parser';

const iso = (v: unknown, order?: 'dmy' | 'mdy') => {
  const r = parseDate(v, order);
  if (!r.ok) throw new Error('ambiguous' in r ? 'ambiguous' : r.error);
  return r.iso;
};

describe('parseDate', () => {
  it('reads ISO, dashed and dotted day-first, month names and Excel serials', () => {
    expect(iso('2026-11-12')).toBe('2026-11-12');
    expect(iso('2026/11/12')).toBe('2026-11-12');
    expect(iso('2026-11-12T10:00:00Z')).toBe('2026-11-12');
    expect(iso('25/11/2026')).toBe('2026-11-25');
    expect(iso('25-11-2026')).toBe('2026-11-25');
    expect(iso('25.11.2026')).toBe('2026-11-25');
    expect(iso('12-Nov-2026')).toBe('2026-11-12');
    expect(iso('12 November 2026')).toBe('2026-11-12');
    expect(iso('Nov 12, 2026')).toBe('2026-11-12');
    expect(iso(46003)).toBe('2025-12-12');
    expect(iso('46003')).toBe('2025-12-12');
    expect(iso(new Date(Date.UTC(2026, 10, 12)))).toBe('2026-11-12');
    expect(iso('۱۲/۱۱/۲۰۲۶', 'dmy')).toBe('2026-11-12');
  });

  it('settles a/b/yyyy only when one reading is impossible or an order is given', () => {
    expect(iso('25/11/2026')).toBe('2026-11-25');
    expect(iso('11/25/2026')).toBe('2026-11-25');
    expect(iso('03/04/2026', 'dmy')).toBe('2026-04-03');
    expect(iso('03/04/2026', 'mdy')).toBe('2026-03-04');
    expect(iso('03/04/26', 'dmy')).toBe('2026-04-03');
  });

  it('reports ambiguity instead of guessing', () => {
    const r = parseDate('03/04/2026');
    expect(r.ok).toBe(false);
    expect('ambiguous' in r && r.ambiguous).toBe(true);
    if (!r.ok && 'ambiguous' in r) {
      expect(r.dmy).toBe('2026-04-03');
      expect(r.mdy).toBe('2026-03-04');
    }
    expect(parseDate('05/05/2026').ok).toBe(true); // both readings agree
  });

  it('refuses impossible dates and junk with a reason', () => {
    for (const bad of [
      '31/02/2026',
      '2026-13-01',
      'yesterday',
      '99/99/9999',
      12,
      true,
    ]) {
      const r = parseDate(bad as never, 'dmy');
      expect(r.ok).toBe(false);
    }
    expect(parseDate('').ok && parseDate('')).toEqual({ ok: true, iso: null });
  });
});

describe('detectDateOrder', () => {
  it('is settled by any value that only reads one way', () => {
    expect(detectDateOrder(['03/04/2026', '25/11/2026'])).toBe('dmy');
    expect(detectDateOrder(['03/04/2026', '11/25/2026'])).toBe('mdy');
    expect(detectDateOrder(['03/04/2026', '05/06/2026', '12/12/2026'])).toBe(
      'ambiguous',
    );
    expect(detectDateOrder(['2026-11-12', 46003, null])).toBe('unneeded');
    expect(detectDateOrder(['25/11/2026', '11/25/2026'])).toBe('ambiguous');
  });
});
