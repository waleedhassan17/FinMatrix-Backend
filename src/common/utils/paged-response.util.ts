import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { toDecimal } from './money.util';

/**
 * A page of a list, shaped so ALL of it reaches the client.
 *
 * ResponseEnvelopeInterceptor keeps only `data` from a payload that has a
 * `data` key — unless the payload already carries `success`, in which case it
 * passes through whole. Lists returned `{ data, pagination }` or
 * `{ data, total, page, limit }`, so every client received a bare array: it
 * could not tell there was a second page, and could only count and total the
 * rows it held. That is how the invoice list came to show "the first 50".
 *
 * `data` stays the same array, so a client that only ever read `data` is
 * unaffected; `pagination` and `summary` ride beside it.
 */
export function pagedResponse<T, S extends object | undefined = undefined>(
  data: T[],
  page: { page: number; limit: number; total: number },
  summary?: S,
) {
  const limit = Math.max(1, page.limit);
  return {
    success: true as const,
    data,
    pagination: {
      page: page.page,
      limit: page.limit,
      total: page.total,
      totalPages: Math.max(1, Math.ceil(page.total / limit)),
    },
    // Kept for any consumer of the older flat shape.
    total: page.total,
    page: page.page,
    limit: page.limit,
    ...(summary !== undefined ? { summary } : {}),
  };
}

export interface StatusSummary<K extends string = string> {
  /** Rows the filters match, every status. */
  count: number;
  /** Per stored status: how many, and each summed column. */
  byStatus: Record<string, { count: number } & Record<K, string>>;
  /** Each summed column over every status. */
  totals: Record<K, string>;
}

/**
 * Counts per status (and optional sums) over EVERYTHING the list's filters
 * match — not over the page a client holds. `qb` must carry the list's filters
 * except the status tab (a tab is a slice of these) and no row-multiplying
 * joins, or the sums double.
 */
export async function statusSummary<
  E extends ObjectLiteral,
  K extends string = never,
>(
  qb: SelectQueryBuilder<E>,
  alias: string,
  sums: Record<K, string> = {} as Record<K, string>,
): Promise<StatusSummary<K>> {
  qb.select(`${alias}.status`, 'status').addSelect('COUNT(*)', 'count');
  for (const [key, column] of Object.entries(sums) as [K, string][]) {
    qb.addSelect(`COALESCE(SUM(${column}), 0)`, key);
  }
  const rows = await qb
    .groupBy(`${alias}.status`)
    .getRawMany<Record<string, string>>();

  const keys = Object.keys(sums) as K[];
  const totals = Object.fromEntries(
    keys.map((k) => [k, toDecimal(0)]),
  ) as Record<K, ReturnType<typeof toDecimal>>;
  const byStatus: StatusSummary<K>['byStatus'] = {};
  let count = 0;
  for (const r of rows) {
    const n = parseInt(r.count, 10) || 0;
    count += n;
    const entry: Record<string, string | number> = { count: n };
    for (const k of keys) {
      const v = toDecimal(r[k] ?? 0);
      entry[k] = v.toFixed(4);
      totals[k] = totals[k].plus(v);
    }
    byStatus[r.status] = entry as { count: number } & Record<K, string>;
  }
  return {
    count,
    byStatus,
    totals: Object.fromEntries(
      keys.map((k) => [k, totals[k].toFixed(4)]),
    ) as Record<K, string>,
  };
}
