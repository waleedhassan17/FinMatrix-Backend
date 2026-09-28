import { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import { toDecimal } from './money.util';

/**
 * Invoices and bills are OVERDUE when they still owe money past their due
 * date — whatever status is stored. The stored `overdue` is only ever written
 * when a payment happens to touch a past-due document, so a past-due invoice
 * nobody has paid anything on still says `sent`. Every read that shows or
 * filters by status goes through this rule, so the list's badges, its tabs,
 * its counts and the dashboard's "overdue" all agree.
 *
 * `openStatuses` are the stored statuses a document can owe money under
 * before it is overdue: `sent`/`partial` for invoices, `open`/`partial` for
 * bills. Draft, paid and void are never overdue.
 */
export function derivedStatus<
  T extends {
    status: string;
    dueDate?: string | null;
    balance?: string | null;
  },
>(doc: T, openStatuses: readonly string[], today: string): T['status'] {
  const owes = toDecimal(doc.balance ?? 0).greaterThan(0);
  if (
    owes &&
    doc.dueDate &&
    doc.dueDate < today &&
    openStatuses.includes(doc.status)
  ) {
    return 'overdue';
  }
  return doc.status;
}

/** SQL twin of derivedStatus. NULL-safe: a document with no due date is never past due. */
export function derivedStatusSql(
  alias: string,
  openStatuses: readonly string[],
): string {
  const open = openStatuses.map((s) => `'${s}'`).join(', ');
  return `CASE WHEN ${alias}.status IN (${open}) AND ${pastDueSql(alias)} THEN 'overdue' ELSE ${alias}.status END`;
}

const pastDueSql = (alias: string): string =>
  `(${alias}.balance > 0 AND ${alias}.dueDate IS NOT NULL AND ${alias}.dueDate < :statusToday)`;

/**
 * Filter a list by the status it DISPLAYS. `overdue` takes the stored overdue
 * ones and every open one past due; an open status (`sent`, `open`, `partial`)
 * takes only those not yet past due — they show as overdue, so they are
 * listed there.
 */
export function applyDerivedStatusFilter<E extends ObjectLiteral>(
  qb: SelectQueryBuilder<E>,
  alias: string,
  status: string | undefined,
  openStatuses: readonly string[],
  today: string,
): void {
  if (!status) return;
  qb.setParameter('statusToday', today);
  if (status === 'overdue') {
    qb.andWhere(
      `(${alias}.status = 'overdue' OR (${alias}.status IN (:...statusOpen) AND ${pastDueSql(alias)}))`,
      {
        statusOpen: [...openStatuses],
      },
    );
  } else if (openStatuses.includes(status)) {
    qb.andWhere(`${alias}.status = :statusValue AND NOT ${pastDueSql(alias)}`, {
      statusValue: status,
    });
  } else {
    qb.andWhere(`${alias}.status = :statusValue`, { statusValue: status });
  }
}

export interface DocumentListSummary {
  /** Documents matching the search, every status. */
  count: number;
  /** What the open documents (open statuses and overdue) still owe. */
  outstanding: string;
  /** Of `outstanding`, what is past due. */
  overdue: string;
  /** Per displayed status: how many, and what they still owe. */
  byStatus: Record<string, { count: number; balance: string }>;
}

/**
 * Counts and balances for a list's tabs and tiles, computed by the server over
 * EVERYTHING the search matches — not over the page a client happens to hold.
 * `qb` carries the list's filters except status (a tab is a slice of these).
 */
export async function documentListSummary<E extends ObjectLiteral>(
  qb: SelectQueryBuilder<E>,
  alias: string,
  openStatuses: readonly string[],
  today: string,
): Promise<DocumentListSummary> {
  const rows = await qb
    .select(derivedStatusSql(alias, openStatuses), 'derived_status')
    .addSelect('COUNT(*)', 'count')
    .addSelect(`COALESCE(SUM(${alias}.balance), 0)`, 'balance')
    .setParameter('statusToday', today)
    .groupBy('derived_status')
    .getRawMany<{ derived_status: string; count: string; balance: string }>();

  const owing = new Set([...openStatuses, 'overdue']);
  let count = 0;
  let outstanding = toDecimal(0);
  let overdue = toDecimal(0);
  const byStatus: DocumentListSummary['byStatus'] = {};
  for (const r of rows) {
    const n = parseInt(r.count, 10) || 0;
    const balance = toDecimal(r.balance ?? 0);
    count += n;
    byStatus[r.derived_status] = { count: n, balance: balance.toFixed(4) };
    if (owing.has(r.derived_status)) outstanding = outstanding.plus(balance);
    if (r.derived_status === 'overdue') overdue = overdue.plus(balance);
  }
  return {
    count,
    outstanding: outstanding.toFixed(4),
    overdue: overdue.toFixed(4),
    byStatus,
  };
}
