import {
  precedingPeriod,
  clampMonth,
  dayBefore,
  fiscalYearEnd,
  fiscalYearOf,
  fiscalYearStart,
  fiscalYearsBetween,
} from './fiscal-year';

describe('fiscal-year', () => {
  describe('January start (the default, and NULL)', () => {
    it('starts on 1 January of the same calendar year', () => {
      expect(fiscalYearStart(1, '2026-10-26')).toBe('2026-01-01');
      expect(fiscalYearEnd(1, '2026-10-26')).toBe('2026-12-31');
      expect(fiscalYearOf(1, '2026-10-26')).toBe(2026);
    });

    it('treats a missing or nonsense month as January', () => {
      expect(clampMonth(null)).toBe(1);
      expect(clampMonth(undefined)).toBe(1);
      expect(clampMonth(0)).toBe(1);
      expect(clampMonth('abc')).toBe(1);
      expect(fiscalYearStart(clampMonth(null), '2026-03-15')).toBe(
        '2026-01-01',
      );
    });

    it('clamps an out-of-range month rather than inventing a year', () => {
      expect(clampMonth(15)).toBe(12);
      expect(clampMonth('7')).toBe(7);
    });
  });

  describe('July start', () => {
    it('puts June in the fiscal year that began the previous July', () => {
      expect(fiscalYearStart(7, '2026-06-30')).toBe('2025-07-01');
      expect(fiscalYearEnd(7, '2026-06-30')).toBe('2026-06-30');
      expect(fiscalYearOf(7, '2026-06-30')).toBe(2025);
    });

    it('starts a new year on 1 July', () => {
      expect(fiscalYearStart(7, '2026-07-15')).toBe('2026-07-01');
      expect(fiscalYearEnd(7, '2026-07-15')).toBe('2027-06-30');
    });
  });

  describe('as of the first day of the fiscal year', () => {
    it('belongs to the year that starts that day, not the one before', () => {
      expect(fiscalYearStart(7, '2026-07-01')).toBe('2026-07-01');
      expect(fiscalYearStart(1, '2026-01-01')).toBe('2026-01-01');
      expect(dayBefore(fiscalYearStart(1, '2026-01-01'))).toBe('2025-12-31');
    });
  });

  describe('leap years', () => {
    it('ends a February year-end on the 29th in a leap year', () => {
      // A March start ends on the last day of February.
      expect(fiscalYearEnd(3, '2027-06-01')).toBe('2028-02-29');
      expect(fiscalYearEnd(3, '2026-06-01')).toBe('2027-02-28');
    });

    it('computes the day before a March start across a leap day', () => {
      expect(dayBefore('2028-03-01')).toBe('2028-02-29');
      expect(dayBefore('2027-03-01')).toBe('2027-02-28');
    });

    it('places 29 February in the year that started the previous March', () => {
      expect(fiscalYearStart(3, '2028-02-29')).toBe('2027-03-01');
    });
  });

  describe('fiscalYearsBetween', () => {
    it('lists every year a range touches, oldest first, with full bounds', () => {
      expect(fiscalYearsBetween(7, '2025-03-01', '2026-08-01')).toEqual([
        { fiscalYear: 2024, startDate: '2024-07-01', endDate: '2025-06-30' },
        { fiscalYear: 2025, startDate: '2025-07-01', endDate: '2026-06-30' },
        { fiscalYear: 2026, startDate: '2026-07-01', endDate: '2027-06-30' },
      ]);
    });

    it('returns nothing for an inverted range', () => {
      expect(fiscalYearsBetween(1, '2026-02-01', '2026-01-01')).toEqual([]);
    });
  });
});

describe('precedingPeriod', () => {
  it('compares whole months with the same number of whole months', () => {
    expect(precedingPeriod('2026-07-01', '2026-12-31')).toEqual({
      startDate: '2026-01-01',
      endDate: '2026-06-30',
    });
    expect(precedingPeriod('2026-03-01', '2026-03-31')).toEqual({
      startDate: '2026-02-01',
      endDate: '2026-02-28',
    });
    expect(precedingPeriod('2026-01-01', '2026-03-31')).toEqual({
      startDate: '2025-10-01',
      endDate: '2025-12-31',
    });
  });

  it('compares any other range with the same number of days before it', () => {
    expect(precedingPeriod('2026-02-10', '2026-02-19')).toEqual({
      startDate: '2026-01-31',
      endDate: '2026-02-09',
    });
    expect(precedingPeriod('2026-01-01', '2026-10-26')).toEqual({
      startDate: '2025-03-08',
      endDate: '2025-12-31',
    });
  });
});
