/**
 * Aging bucket definitions — how late is "late".
 *
 * The A/R and A/P aging reports used to hardcode 30/60/90 in three places at
 * once: the boundaries themselves, the five accumulator field names, and the
 * totals reducer. A warehouse trading on 3-day or 7-day terms saw every open
 * document collapse into "Current", which is the same as having no aging report
 * at all.
 *
 * This module is the whole bucketing decision, and it is deliberately free of
 * I/O, Nest and TypeORM so the boundary arithmetic can be unit-tested directly.
 *
 * ── On the legacy fields ──────────────────────────────────────────────────
 * ReportsService still emits `current`/`bucket1to30`/`bucket31to60`/
 * `bucket61to90`/`bucket90Plus` alongside the configurable `buckets[]`, and
 * those five are ALWAYS computed on LEGACY_BOUNDARIES no matter which preset
 * was asked for. That is not indecision — a shipped Android build and a live
 * website read those names today, `analyticsDashboard` builds its arAgingTrend
 * from them, and three CI suites assert on them. Re-bucketing changes how the
 * same money is sliced, never how much of it there is, so both shapes can
 * describe one set of books without disagreeing.
 */

export interface AgingBucketDef {
  /** Stable machine key. Clients read `row.amounts[key]`. */
  key: string;
  /** What the column says: 'Current', '1–30', '91 and over'. */
  label: string;
  /** Inclusive lower bound in days overdue. 0 for the not-yet-due bucket. */
  minDays: number;
  /** Inclusive upper bound; null on the open-ended final bucket. */
  maxDays: number | null;
}

export type AgingPresetKey =
  | 'days3'
  | 'weekly'
  | 'biweekly'
  | 'monthly'
  | 'custom';

/**
 * Upper bounds in days overdue. The trailing open-ended bucket is implied, so
 * [30, 60, 90] describes five buckets: Current, 1–30, 31–60, 61–90, 91+.
 */
export const AGING_PRESETS: Record<
  Exclude<AgingPresetKey, 'custom'>,
  number[]
> = {
  days3: [3, 6, 9, 12],
  weekly: [7, 14, 21, 28],
  biweekly: [14, 28, 42, 56],
  monthly: [30, 60, 90],
};

export const DEFAULT_PRESET: AgingPresetKey = 'monthly';

/** The boundaries the five back-compat fields are always computed on. */
export const LEGACY_BOUNDARIES = [30, 60, 90] as const;

/**
 * A ceiling on custom boundaries. Twelve gives fourteen columns, which is
 * already past the point where a table reads better than a chart; beyond it the
 * response stops being a report and starts being a histogram.
 */
export const MAX_BOUNDARIES = 12;

/** En dash, matching the '1–30' headings the clients already render. */
const EN_DASH = '–';

export class AgingBucketSpecError extends Error {}

/**
 * Turn a list of upper bounds into the bucket set, newest first.
 *
 * Boundaries must be whole numbers, strictly ascending, and at least 1 — a
 * boundary of 0 would duplicate the Current bucket, and a repeated boundary
 * would emit a column that can never match.
 */
export function buildBucketSpec(
  boundaries: readonly number[],
): AgingBucketDef[] {
  if (boundaries.length === 0) {
    throw new AgingBucketSpecError(
      'Give at least one aging boundary, e.g. 30,60,90.',
    );
  }
  if (boundaries.length > MAX_BOUNDARIES) {
    throw new AgingBucketSpecError(
      `At most ${MAX_BOUNDARIES} aging boundaries; ${boundaries.length} were given.`,
    );
  }
  boundaries.forEach((b, i) => {
    if (!Number.isInteger(b) || b < 1) {
      throw new AgingBucketSpecError(
        `Aging boundaries are whole days of 1 or more; got ${b}.`,
      );
    }
    if (i > 0 && b <= boundaries[i - 1]) {
      throw new AgingBucketSpecError(
        `Aging boundaries must ascend; ${boundaries[i - 1]} is followed by ${b}.`,
      );
    }
  });

  const buckets: AgingBucketDef[] = [
    { key: 'current', label: 'Current', minDays: 0, maxDays: 0 },
  ];
  boundaries.forEach((max, i) => {
    const min = i === 0 ? 1 : boundaries[i - 1] + 1;
    buckets.push({
      key: `d${min}to${max}`,
      label: min === max ? `${min}` : `${min}${EN_DASH}${max}`,
      minDays: min,
      maxDays: max,
    });
  });
  const last = boundaries[boundaries.length - 1] + 1;
  buckets.push({
    key: `d${last}plus`,
    label: `${last} and over`,
    minDays: last,
    maxDays: null,
  });
  return buckets;
}

/**
 * Which bucket a document falls in. `daysOverdue` is 0 or negative for anything
 * not yet due, which is what makes Current a real bucket rather than a
 * left-over.
 */
export function bucketKeyFor(
  daysOverdue: number,
  spec: readonly AgingBucketDef[],
): string {
  if (daysOverdue <= 0) return spec[0].key;
  for (const b of spec) {
    if (b.minDays === 0) continue;
    if (
      daysOverdue >= b.minDays &&
      (b.maxDays === null || daysOverdue <= b.maxDays)
    ) {
      return b.key;
    }
  }
  // Unreachable: the final bucket is open-ended. Kept so a future edit that
  // closes it fails loudly here instead of silently dropping the money.
  return spec[spec.length - 1].key;
}

/** Parse the `buckets=3,6,9,12` query form. Throws on anything malformed. */
export function parseBoundaries(raw: string): number[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) {
    throw new AgingBucketSpecError('No aging boundaries were given.');
  }
  return parts.map((s) => {
    if (!/^\d{1,4}$/.test(s)) {
      throw new AgingBucketSpecError(`"${s}" is not a whole number of days.`);
    }
    return Number(s);
  });
}

export interface AgingSpecRequest {
  preset?: AgingPresetKey | null;
  buckets?: string | null;
}

export interface ResolvedAgingSpec {
  preset: AgingPresetKey;
  boundaries: number[];
  spec: AgingBucketDef[];
}

/**
 * Settle on a bucket set from the request, falling back to the company's saved
 * preference and then to the classic 30/60/90.
 *
 * The saved preference is resolved HERE rather than on the client so that a
 * company default also governs the CSV export and any other consumer, not just
 * the screen that happened to set it.
 */
export function resolveAgingSpec(
  request: AgingSpecRequest | null | undefined,
  saved?: AgingSpecRequest | null,
): ResolvedAgingSpec {
  const pick = (
    src: AgingSpecRequest | null | undefined,
  ): ResolvedAgingSpec | null => {
    if (!src) return null;
    if (src.preset === 'custom') {
      if (!src.buckets) {
        throw new AgingBucketSpecError(
          'preset=custom needs a buckets list, e.g. buckets=3,6,9.',
        );
      }
      const boundaries = parseBoundaries(src.buckets);
      return {
        preset: 'custom',
        boundaries,
        spec: buildBucketSpec(boundaries),
      };
    }
    if (src.preset) {
      const boundaries = AGING_PRESETS[src.preset];
      if (!boundaries)
        throw new AgingBucketSpecError(`Unknown aging preset "${src.preset}".`);
      return {
        preset: src.preset,
        boundaries: [...boundaries],
        spec: buildBucketSpec(boundaries),
      };
    }
    // Boundaries with no preset named is still a custom request.
    if (src.buckets) {
      const boundaries = parseBoundaries(src.buckets);
      return {
        preset: 'custom',
        boundaries,
        spec: buildBucketSpec(boundaries),
      };
    }
    return null;
  };

  // A malformed SAVED preference must not break the report — it would make the
  // page unopenable with no way to get back and fix it. A malformed REQUEST is
  // the caller's problem and is thrown.
  let fromSaved: ResolvedAgingSpec | null = null;
  try {
    fromSaved = pick(saved);
  } catch {
    fromSaved = null;
  }

  return (
    pick(request) ??
    fromSaved ?? {
      preset: DEFAULT_PRESET,
      boundaries: [
        ...AGING_PRESETS[DEFAULT_PRESET as Exclude<AgingPresetKey, 'custom'>],
      ],
      spec: buildBucketSpec(
        AGING_PRESETS[DEFAULT_PRESET as Exclude<AgingPresetKey, 'custom'>],
      ),
    }
  );
}
