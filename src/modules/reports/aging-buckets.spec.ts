import {
  AGING_PRESETS,
  AgingBucketSpecError,
  LEGACY_BOUNDARIES,
  MAX_BOUNDARIES,
  bucketKeyFor,
  buildBucketSpec,
  parseBoundaries,
  resolveAgingSpec,
} from './aging-buckets';
import { daysBetweenIso } from '../../common/utils/business-date.util';

describe('buildBucketSpec', () => {
  it('reproduces the classic 30/60/90 columns', () => {
    const spec = buildBucketSpec([...LEGACY_BOUNDARIES]);
    expect(spec.map((b) => b.label)).toEqual([
      'Current',
      '1–30',
      '31–60',
      '61–90',
      '91 and over',
    ]);
    expect(spec.map((b) => b.key)).toEqual([
      'current',
      'd1to30',
      'd31to60',
      'd61to90',
      'd91plus',
    ]);
  });

  it('leaves no gap and no overlap between adjacent buckets', () => {
    for (const boundaries of Object.values(AGING_PRESETS)) {
      const spec = buildBucketSpec(boundaries);
      for (let i = 1; i < spec.length - 1; i += 1) {
        // Each overdue bucket starts the day after the previous one ends, so a
        // document can never fall between two columns or be counted twice.
        expect(spec[i].minDays).toBe((spec[i - 1].maxDays as number) + 1);
      }
      expect(spec[spec.length - 1].maxDays).toBeNull();
    }
  });

  it('labels a one-day-wide bucket as a single number, not "3–3"', () => {
    const spec = buildBucketSpec([1, 2, 3]);
    expect(spec.map((b) => b.label)).toEqual([
      'Current',
      '1',
      '2',
      '3',
      '4 and over',
    ]);
  });

  it('refuses boundaries that do not ascend', () => {
    expect(() => buildBucketSpec([30, 30])).toThrow(AgingBucketSpecError);
    expect(() => buildBucketSpec([60, 30])).toThrow(AgingBucketSpecError);
  });

  it('refuses a zero, a fraction and an empty list', () => {
    expect(() => buildBucketSpec([0, 30])).toThrow(AgingBucketSpecError);
    expect(() => buildBucketSpec([1.5])).toThrow(AgingBucketSpecError);
    expect(() => buildBucketSpec([])).toThrow(AgingBucketSpecError);
  });

  it('caps how many columns a caller can ask for', () => {
    const tooMany = Array.from({ length: MAX_BOUNDARIES + 1 }, (_, i) => i + 1);
    expect(() => buildBucketSpec(tooMany)).toThrow(AgingBucketSpecError);
  });
});

describe('bucketKeyFor', () => {
  const spec = buildBucketSpec([...LEGACY_BOUNDARIES]);

  it('puts anything not yet due in Current, including due exactly today', () => {
    expect(bucketKeyFor(0, spec)).toBe('current');
    expect(bucketKeyFor(-7, spec)).toBe('current');
  });

  it('lands on the right side of every boundary', () => {
    // The off-by-one that a 30/60/90 report hides and a 3-day report shows.
    expect(bucketKeyFor(1, spec)).toBe('d1to30');
    expect(bucketKeyFor(30, spec)).toBe('d1to30');
    expect(bucketKeyFor(31, spec)).toBe('d31to60');
    expect(bucketKeyFor(90, spec)).toBe('d61to90');
    expect(bucketKeyFor(91, spec)).toBe('d91plus');
    expect(bucketKeyFor(100000, spec)).toBe('d91plus');
  });

  it('assigns every whole day from -5 to 400 to exactly one bucket', () => {
    for (const boundaries of Object.values(AGING_PRESETS)) {
      const s = buildBucketSpec(boundaries);
      for (let d = -5; d <= 400; d += 1) {
        const hits = s.filter((b) =>
          d <= 0
            ? b.minDays === 0
            : b.minDays !== 0 &&
              d >= b.minDays &&
              (b.maxDays === null || d <= b.maxDays),
        );
        expect(hits).toHaveLength(1);
        expect(bucketKeyFor(d, s)).toBe(hits[0].key);
      }
    }
  });
});

describe('daysBetweenIso', () => {
  it('counts calendar days, not elapsed milliseconds', () => {
    expect(daysBetweenIso('2026-09-01', '2026-09-01')).toBe(0);
    expect(daysBetweenIso('2026-09-01', '2026-09-02')).toBe(1);
    expect(daysBetweenIso('2026-09-02', '2026-09-01')).toBe(-1);
  });

  it('crosses months, years and a leap day without drifting', () => {
    expect(daysBetweenIso('2026-01-31', '2026-02-01')).toBe(1);
    expect(daysBetweenIso('2025-12-31', '2026-01-01')).toBe(1);
    // 2028 is a leap year: February has 29 days.
    expect(daysBetweenIso('2028-02-28', '2028-03-01')).toBe(2);
    expect(daysBetweenIso('2026-01-01', '2027-01-01')).toBe(365);
  });

  it('ignores a time component on either end', () => {
    // due_date is a DATE column but callers hand us timestamps too.
    expect(daysBetweenIso('2026-09-01T23:59:59Z', '2026-09-02T00:00:01Z')).toBe(
      1,
    );
  });
});

describe('resolveAgingSpec', () => {
  it('defaults to the classic buckets when nothing is asked for or saved', () => {
    const r = resolveAgingSpec(null, null);
    expect(r.preset).toBe('monthly');
    expect(r.boundaries).toEqual([30, 60, 90]);
  });

  it('uses the saved company preference when the request names none', () => {
    const r = resolveAgingSpec({}, { preset: 'weekly' });
    expect(r.preset).toBe('weekly');
    expect(r.boundaries).toEqual([7, 14, 21, 28]);
  });

  it('lets the request override the saved preference', () => {
    const r = resolveAgingSpec({ preset: 'days3' }, { preset: 'weekly' });
    expect(r.preset).toBe('days3');
    expect(r.boundaries).toEqual([3, 6, 9, 12]);
  });

  it('accepts a custom list, with or without preset=custom', () => {
    expect(
      resolveAgingSpec({ preset: 'custom', buckets: '5,10,15' }).boundaries,
    ).toEqual([5, 10, 15]);
    expect(resolveAgingSpec({ buckets: '5,10,15' }).preset).toBe('custom');
  });

  it('throws on a malformed REQUEST', () => {
    expect(() => resolveAgingSpec({ buckets: '10,abc' })).toThrow(
      AgingBucketSpecError,
    );
    expect(() => resolveAgingSpec({ preset: 'custom' })).toThrow(
      AgingBucketSpecError,
    );
  });

  it('falls back rather than throwing on a malformed SAVED preference', () => {
    // A bad saved value must never make the report unopenable — there would be
    // no way to get back in and fix it.
    const r = resolveAgingSpec({}, { preset: 'custom', buckets: 'nonsense' });
    expect(r.preset).toBe('monthly');
    expect(r.boundaries).toEqual([30, 60, 90]);
  });
});

describe('parseBoundaries', () => {
  it('tolerates spaces and a trailing comma', () => {
    expect(parseBoundaries(' 3, 6 ,9, ')).toEqual([3, 6, 9]);
  });

  it('rejects negatives and decimals at the string level', () => {
    expect(() => parseBoundaries('-3,6')).toThrow(AgingBucketSpecError);
    expect(() => parseBoundaries('3.5,6')).toThrow(AgingBucketSpecError);
    expect(() => parseBoundaries('')).toThrow(AgingBucketSpecError);
  });
});
