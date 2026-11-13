import { EntityManager } from 'typeorm';

/**
 * The EXPECTED side of every check: plain SQL over the staging rows, and
 * nothing else. No service, no Decimal helper shared with the posting side —
 * so the two sides of a check cannot agree by accident of sharing code.
 *
 * Amounts come back as text from numeric SUMs and are compared with Decimal
 * by the checks service at full precision. Only rows the batch will import
 * (`outcome = 'imported'`) count; merged and rejected rows carry no amounts
 * into the books.
 */
const IMPORTED = `batch_id = $1 AND company_id = $2 AND outcome = 'imported'`;

export interface SourceTrialBalance {
  debits: string;
  credits: string;
  rows: number;
}

export async function expectedSourceTrialBalance(
  em: EntityManager,
  batchId: string,
  companyId: string,
): Promise<SourceTrialBalance> {
  const [r] = await em.query(
    `SELECT COALESCE(SUM((normalized->>'debit')::numeric), 0)::text AS debits,
            COALESCE(SUM((normalized->>'credit')::numeric), 0)::text AS credits,
            COUNT(*)::int AS rows
       FROM migration_staging_rows
      WHERE ${IMPORTED} AND entity_type = 'trial_balance'`,
    [batchId, companyId],
  );
  return { debits: r.debits, credits: r.credits, rows: Number(r.rows) };
}

/** Net (debit − credit) per FinMatrix account number the source rows map to. */
export async function expectedAccountNets(
  em: EntityManager,
  batchId: string,
  companyId: string,
): Promise<Array<{ account: string; net: string }>> {
  return em.query(
    `SELECT CASE WHEN normalized->>'targetAccount' = 'NEW' THEN normalized->>'accountNumber' ELSE normalized->>'targetAccount' END AS account,
            (COALESCE(SUM((normalized->>'debit')::numeric), 0) - COALESCE(SUM((normalized->>'credit')::numeric), 0))::text AS net
       FROM migration_staging_rows
      WHERE ${IMPORTED} AND entity_type = 'trial_balance'
      GROUP BY 1 ORDER BY 1`,
    [batchId, companyId],
  );
}

/** The trial balance's net on one FinMatrix control account (1100, 2000, 1200). */
export async function expectedControlNet(
  em: EntityManager,
  batchId: string,
  companyId: string,
  account: string,
): Promise<string> {
  const [r] = await em.query(
    `SELECT (COALESCE(SUM((normalized->>'debit')::numeric), 0) - COALESCE(SUM((normalized->>'credit')::numeric), 0))::text AS net
       FROM migration_staging_rows
      WHERE ${IMPORTED} AND entity_type = 'trial_balance' AND normalized->>'targetAccount' = $3`,
    [batchId, companyId, account],
  );
  return r.net;
}

export interface PartyExpectation {
  /** `${kind}:${id}` of the resolved reference (row, existing or create). */
  refKey: string;
  refName: string;
  due: string;
  count: number;
}

export async function expectedOpenItemsByParty(
  em: EntityManager,
  batchId: string,
  companyId: string,
  entity: 'open_invoices' | 'open_bills',
): Promise<PartyExpectation[]> {
  const field = entity === 'open_invoices' ? 'customer' : 'vendor';
  return em.query(
    `SELECT (normalized->'${field}Ref'->>'kind') || ':' || (normalized->'${field}Ref'->>'id') AS "refKey",
            MIN(normalized->>'${field}') AS "refName",
            COALESCE(SUM((normalized->>'amountDue')::numeric), 0)::text AS due,
            COUNT(*)::int AS count
       FROM migration_staging_rows
      WHERE ${IMPORTED} AND entity_type = '${entity}'
      GROUP BY 1 ORDER BY 1`,
    [batchId, companyId],
  );
}

export async function expectedOpenItemsTotal(
  em: EntityManager,
  batchId: string,
  companyId: string,
  entity: 'open_invoices' | 'open_bills',
): Promise<string> {
  const [r] = await em.query(
    `SELECT COALESCE(SUM((normalized->>'amountDue')::numeric), 0)::text AS due
       FROM migration_staging_rows WHERE ${IMPORTED} AND entity_type = '${entity}'`,
    [batchId, companyId],
  );
  return r.due;
}

export interface StockExpectation {
  refKey: string;
  sku: string;
  quantity: string;
  value: string;
}

export async function expectedStockByItem(
  em: EntityManager,
  batchId: string,
  companyId: string,
): Promise<StockExpectation[]> {
  return em.query(
    `SELECT (normalized->'skuRef'->>'kind') || ':' || (normalized->'skuRef'->>'id') AS "refKey",
            MIN(normalized->>'sku') AS sku,
            COALESCE(SUM((normalized->>'quantityOnHand')::numeric), 0)::text AS quantity,
            COALESCE(SUM((normalized->>'quantityOnHand')::numeric * (normalized->>'unitCost')::numeric), 0)::text AS value
       FROM migration_staging_rows
      WHERE ${IMPORTED} AND entity_type = 'stock'
      GROUP BY 1 ORDER BY 1`,
    [batchId, companyId],
  );
}

export async function expectedStockTotal(
  em: EntityManager,
  batchId: string,
  companyId: string,
): Promise<string> {
  const [r] = await em.query(
    `SELECT COALESCE(SUM((normalized->>'quantityOnHand')::numeric * (normalized->>'unitCost')::numeric), 0)::text AS value
       FROM migration_staging_rows WHERE ${IMPORTED} AND entity_type = 'stock'`,
    [batchId, companyId],
  );
  return r.value;
}

/** Source rows per entity and their outcomes — the first check. */
export interface ReadbackRow {
  sheet: string;
  rowNumber: number;
  entityType: string;
  normalized: Record<string, unknown> | null;
}

/** Every imported row with its figures and the text they were typed as. */
export async function expectedReadbackRows(
  em: EntityManager,
  batchId: string,
  companyId: string,
): Promise<ReadbackRow[]> {
  return em.query(
    `SELECT sheet, row_number AS "rowNumber", entity_type AS "entityType", normalized
       FROM migration_staging_rows
      WHERE ${IMPORTED}
      ORDER BY sheet, row_number`,
    [batchId, companyId],
  );
}

export async function expectedRowsAccounted(
  em: EntityManager,
  batchId: string,
  companyId: string,
) {
  return em.query(
    `SELECT COALESCE(entity_type, 'unknown') AS entity,
            COUNT(*)::int AS source,
            COUNT(*) FILTER (WHERE outcome = 'imported')::int AS imported,
            COUNT(*) FILTER (WHERE outcome = 'merged')::int AS merged,
            COUNT(*) FILTER (WHERE outcome = 'rejected')::int AS rejected,
            COUNT(*) FILTER (WHERE outcome = 'rejected' AND (reason IS NULL OR reason = ''))::int AS "rejectedWithoutReason",
            COUNT(*) FILTER (WHERE outcome = 'pending')::int AS pending
       FROM migration_staging_rows
      WHERE batch_id = $1 AND company_id = $2
      GROUP BY 1 ORDER BY 1`,
    [batchId, companyId],
  ) as Promise<
    Array<{
      entity: string;
      source: number;
      imported: number;
      merged: number;
      rejected: number;
      rejectedWithoutReason: number;
      pending: number;
    }>
  >;
}

/** The staging values a committed record must reproduce (round trip). */
export async function expectedRoundTripRows(
  em: EntityManager,
  batchId: string,
  companyId: string,
  entity: string,
): Promise<
  Array<{
    id: string;
    sheet: string;
    rowNumber: number;
    normalized: Record<string, unknown>;
  }>
> {
  return em.query(
    `SELECT id, sheet, row_number AS "rowNumber", normalized
       FROM migration_staging_rows WHERE ${IMPORTED} AND entity_type = $3 ORDER BY sheet, row_number`,
    [batchId, companyId, entity],
  );
}
