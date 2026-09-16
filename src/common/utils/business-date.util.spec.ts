import { addDaysIso, businessTimezone, businessToday, termsDays } from './business-date.util';

describe('businessToday', () => {
  const original = process.env.BUSINESS_TIMEZONE;
  afterEach(() => {
    if (original === undefined) delete process.env.BUSINESS_TIMEZONE;
    else process.env.BUSINESS_TIMEZONE = original;
  });

  it('is the Pakistan calendar day, not the UTC one, just after midnight PKT', () => {
    delete process.env.BUSINESS_TIMEZONE;
    // 00:30 on the 16th in Karachi is still 19:30 on the 15th in UTC.
    const instant = new Date('2026-09-15T19:30:00Z');
    expect(instant.toISOString().slice(0, 10)).toBe('2026-09-15');
    expect(businessToday(undefined, instant)).toBe('2026-09-16');
  });

  it('ignores the UTC placeholder and invalid zones, but honours a real company zone', () => {
    delete process.env.BUSINESS_TIMEZONE;
    expect(businessTimezone('UTC')).toBe('Asia/Karachi');
    expect(businessTimezone('Not/AZone')).toBe('Asia/Karachi');
    expect(businessTimezone('Asia/Dubai')).toBe('Asia/Dubai');
    const instant = new Date('2026-09-15T19:30:00Z');
    expect(businessToday('Asia/Dubai', instant)).toBe('2026-09-15');
  });

  it('uses BUSINESS_TIMEZONE when no company zone is given', () => {
    process.env.BUSINESS_TIMEZONE = 'Europe/London';
    expect(businessTimezone()).toBe('Europe/London');
  });
});

describe('addDaysIso / termsDays', () => {
  it('adds calendar days across month and year ends', () => {
    expect(addDaysIso('2026-09-16', 30)).toBe('2026-10-16');
    expect(addDaysIso('2026-12-20', 15)).toBe('2027-01-04');
  });

  it('reads both the stored and the underscored payment-terms codes', () => {
    expect(termsDays('net30')).toBe(30);
    expect(termsDays('net_45')).toBe(45);
    expect(termsDays('due_on_receipt')).toBe(0);
    expect(termsDays(null)).toBe(30);
    expect(termsDays('custom', 14)).toBe(14);
  });
});
