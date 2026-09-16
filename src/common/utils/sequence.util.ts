import { EntityManager, ObjectLiteral } from 'typeorm';
import { formatYearlyRef } from './reference-generator.util';

/**
 * Per-company, per-year document number series.
 *
 * Every document type keeps its OWN series — INV-2026-0027 and PO-2026-0027 are
 * different documents, told apart by their prefix, the way QuickBooks, Zoho and
 * SAP number them (and the way an FBR auditor expects an unbroken invoice run).
 *
 * The series used to be `COUNT(*) + 1` over the document table, unlocked. That
 * reused numbers: invoices, estimates, sales orders, bills and credits are hard
 * deleted, so deleting one lowered the count and the next document was handed
 * a number that already existed — a unique-index 500 on invoices, POs and
 * sales orders, and a silent duplicate on bills. Two users saving at once could
 * also both read the same count.
 *
 * `document_sequences` holds the last number issued. The UPDATE takes a row
 * lock that lasts until the caller's transaction commits, so concurrent creates
 * queue behind one another; and because the counter lives in that same
 * transaction, a create that rolls back gives its number back — the invoice run
 * stays gap-free.
 */
export type DocumentSeries = 'INV' | 'EST' | 'SO' | 'PO' | 'BILL' | 'CM' | 'VC' | 'RCT';

const SERIES_SOURCE: Record<DocumentSeries, { table: string; column: string }> = {
  INV: { table: 'invoices', column: 'invoice_number' },
  EST: { table: 'estimates', column: 'estimate_number' },
  SO: { table: 'sales_orders', column: 'order_number' },
  PO: { table: 'purchase_orders', column: 'po_number' },
  BILL: { table: 'bills', column: 'bill_number' },
  CM: { table: 'credit_memos', column: 'credit_memo_number' },
  VC: { table: 'vendor_credits', column: 'vendor_credit_number' },
  RCT: { table: 'payments', column: 'payment_number' },
};

/** TypeORM hands back `[rows, rowCount]` for UPDATE … RETURNING on Postgres. */
function returnedRows(raw: unknown): ObjectLiteral[] {
  if (Array.isArray(raw) && raw.length === 2 && Array.isArray(raw[0]) && typeof raw[1] === 'number') {
    return raw[0] as ObjectLiteral[];
  }
  return (raw as ObjectLiteral[]) ?? [];
}

/** The next number in a series. Must be called inside the creating transaction. */
export async function nextDocumentSequence(
  manager: EntityManager,
  companyId: string,
  series: DocumentSeries,
  year: number,
): Promise<number> {
  const bumped = returnedRows(
    await manager.query(
      `UPDATE document_sequences
          SET last_value = last_value + 1, updated_at = now()
        WHERE company_id = $1 AND doc_type = $2 AND year = $3
      RETURNING last_value`,
      [companyId, series, year],
    ),
  );
  if (bumped.length > 0) return Number(bumped[0].last_value);

  // First document of this series and year for the company. Seed from the
  // highest number already issued, so a company whose documents predate this
  // table never collides with its own history. ON CONFLICT covers two first
  // documents racing each other.
  const { table, column } = SERIES_SOURCE[series];
  const pattern = `^${series}-${year}-[0-9]+$`;
  const seeded = await manager.query<ObjectLiteral[]>(
    `INSERT INTO document_sequences (company_id, doc_type, year, last_value, updated_at)
     VALUES (
       $1, $2, $3,
       COALESCE((
         SELECT MAX(CAST(substring(${column} FROM '[0-9]+$') AS integer))
           FROM ${table}
          WHERE company_id = $1 AND ${column} ~ $4
       ), 0) + 1,
       now()
     )
     ON CONFLICT (company_id, doc_type, year)
       DO UPDATE SET last_value = document_sequences.last_value + 1, updated_at = now()
     RETURNING last_value`,
    [companyId, series, year, pattern],
  );
  return Number(returnedRows(seeded)[0].last_value);
}

/** The next formatted number, e.g. `INV-2026-0028`. */
export async function nextDocumentNumber(
  manager: EntityManager,
  companyId: string,
  series: DocumentSeries,
  year: number,
): Promise<string> {
  const seq = await nextDocumentSequence(manager, companyId, series, year);
  return formatYearlyRef(series, year, seq);
}

/** Year of an ISO date string, for choosing the series year. */
export function yearOf(isoDate: string): number {
  return parseInt(isoDate.slice(0, 4), 10);
}
