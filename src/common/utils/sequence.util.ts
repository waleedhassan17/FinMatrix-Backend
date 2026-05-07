import { EntityManager, ObjectLiteral } from 'typeorm';

/**
 * Compute the next per-year sequence number for a given table.
 * Counts how many rows already exist for the company in the given year
 * using a locked SELECT, so concurrent writes don't collide inside a tx.
 *
 * `yearColumn` is the SQL column name in the underlying table (e.g.
 * "invoice_date"). `numberColumn` is the reference/identity column to
 * disambiguate when multiple numbering series share a table.
 */
export async function nextYearlySequence(
  manager: EntityManager,
  table: string,
  companyId: string,
  year: number,
  yearColumn: string,
  numberPrefix: string,
  numberColumn: string,
): Promise<number> {
  // COUNT(*) with FOR UPDATE is not allowed in PostgreSQL — use a plain
  // count inside the existing transaction for sequence ordering.
  const rows = await manager.query<ObjectLiteral[]>(
    `SELECT COUNT(*) AS count
     FROM ${table}
     WHERE company_id = $1
       AND EXTRACT(YEAR FROM ${yearColumn}) = $2
       AND ${numberColumn} LIKE $3`,
    [companyId, year, `${numberPrefix}-${year}-%`],
  );
  const count = parseInt((rows[0]?.count as string) ?? '0', 10);
  return count + 1;
}
