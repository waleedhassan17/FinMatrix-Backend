import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { normalizePartyCode } from './party-code.util';

export type PartyListSort = 'recent' | 'code' | 'name' | 'balance';

/**
 * The order of a customer or vendor list, decided by the server.
 *
 * The lists used to arrive newest-first and the clients re-sorted whatever
 * page they held, so "A–Z" or "Balance" only ever ordered the 50 rows on
 * screen. Every order ends on `id`, so paging never repeats or skips a row.
 *
 * `code` is natural order — C-2 before C-10 — by prefix, then the trailing
 * number, then the code itself; parties without a code come last. Whatever the
 * order, a party whose ID is exactly the search term comes first: typing an ID
 * should put that party at the top, not somewhere among the partial matches.
 */
export function orderPartyList<T extends ObjectLiteral>(
  qb: SelectQueryBuilder<T>,
  alias: string,
  options: { sort?: PartyListSort; nameProperty: string; search?: string },
): void {
  const exact = normalizePartyCode(options.search);
  let first = true;
  const add = (
    expression: string,
    order: 'ASC' | 'DESC',
    nulls?: 'NULLS FIRST' | 'NULLS LAST',
  ) => {
    if (first) qb.orderBy(expression, order, nulls);
    else qb.addOrderBy(expression, order, nulls);
    first = false;
  };

  if (exact) {
    qb.setParameter('exactPartyCode', exact);
    add(`CASE WHEN ${alias}.code = :exactPartyCode THEN 0 ELSE 1 END`, 'ASC');
  }

  switch (options.sort ?? 'recent') {
    case 'code':
      add(`CASE WHEN ${alias}.code IS NULL THEN 1 ELSE 0 END`, 'ASC');
      add(`regexp_replace(COALESCE(${alias}.code, ''), '[0-9]+$', '')`, 'ASC');
      add(
        `CAST(NULLIF(substring(${alias}.code FROM '[0-9]+$'), '') AS numeric)`,
        'ASC',
        'NULLS FIRST',
      );
      add(`${alias}.code`, 'ASC');
      add(`${alias}.id`, 'ASC');
      break;
    case 'name':
      add(`LOWER(${alias}.${options.nameProperty})`, 'ASC');
      add(`${alias}.id`, 'ASC');
      break;
    case 'balance':
      add(`${alias}.balance`, 'DESC');
      add(`${alias}.id`, 'ASC');
      break;
    default:
      add(`${alias}.createdAt`, 'DESC');
      add(`${alias}.id`, 'DESC');
  }
}

/** `isActive`, or the app's status chip when that is all that was sent. */
export function activeFilterOf(query: {
  isActive?: boolean;
  status?: 'all' | 'active' | 'inactive';
}): boolean | undefined {
  if (query.isActive !== undefined) return query.isActive;
  if (query.status === 'active') return true;
  if (query.status === 'inactive') return false;
  return undefined;
}
