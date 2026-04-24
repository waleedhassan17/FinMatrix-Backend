/**
 * Reference-number helpers used across accounting modules.
 *
 * Numbering conventions (per-company sequences; stored as unique indexes):
 *   Journal Entry:   JE-XXX         (simple integer per company)
 *   Invoice:         INV-YYYY-XXXX  (reset per year)
 *   Estimate:        EST-YYYY-XXXX
 *   Sales Order:     SO-YYYY-XXXX
 *   Purchase Order:  PO-YYYY-XXXX
 *   Bill:            BILL-YYYY-XXXX
 *
 * Services are responsible for computing the next `sequence` value
 * (typically by SELECT MAX(... ) FOR UPDATE inside a transaction) and
 * calling the formatter below.
 */

export function formatJournalRef(sequence: number): string {
  return `JE-${String(sequence).padStart(3, '0')}`;
}

export function formatYearlyRef(
  prefix: string,
  year: number,
  sequence: number,
): string {
  return `${prefix}-${year}-${String(sequence).padStart(4, '0')}`;
}

export const formatInvoiceRef = (year: number, seq: number) =>
  formatYearlyRef('INV', year, seq);
export const formatEstimateRef = (year: number, seq: number) =>
  formatYearlyRef('EST', year, seq);
export const formatSalesOrderRef = (year: number, seq: number) =>
  formatYearlyRef('SO', year, seq);
export const formatPurchaseOrderRef = (year: number, seq: number) =>
  formatYearlyRef('PO', year, seq);
export const formatBillRef = (year: number, seq: number) =>
  formatYearlyRef('BILL', year, seq);

/**
 * 6-character alphanumeric invite code for companies.
 * Uses an unambiguous alphabet (no 0/O/1/I).
 */
export function generateInviteCode(length = 6): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < length; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return out;
}
