/**
 * A customer's or vendor's postings, read from the book.
 *
 * `general_ledger` carries no party column — each row names its source
 * document (`source_type`, `source_id`) — so a party's ledger is the control
 * account's rows joined back to the documents that posted them:
 *
 *   customer  1100 Accounts Receivable and 2400 Customer Advances, through
 *             invoices, receipts (payments), credit memos and deliveries
 *   vendor    2000 Accounts Payable, through bills, bill payments and vendor
 *             credits
 *
 * Reading the postings rather than the documents is what makes the ledger
 * agree with the books. A void shows on the day it was voided, so a closed
 * period never changes; a legacy prepaid delivery's advance (Dr Cash / Cr 2400,
 * with no receipt) is counted; and a receipt or bill that was deleted — its
 * row gone, its postings and their reversal still in the book — is traced to
 * its party through the before-image its delete left in audit_trail.
 *
 * Rows whose source names no party (a manual journal straight to 1100, an
 * opening balance) come back with a NULL party: they are the difference
 * between the parties' total and the control account.
 */
export type LedgerPartyType = 'customer' | 'vendor';

interface PartySources {
  joins: string;
  documentType: string;
  documentId: string;
  documentNumber: string;
  partyId: string;
}

/** A uuid out of an audit before-image, or NULL rather than a cast error. */
const auditUuid = (key: string) =>
  `CASE WHEN t.before_values->>'${key}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN CAST(t.before_values->>'${key}' AS uuid) END`;

const SOURCES: Record<LedgerPartyType, PartySources> = {
  customer: {
    joins: `
      LEFT JOIN invoices i
        ON g.source_type IN ('invoice', 'invoice_void') AND i.id = g.source_id
      LEFT JOIN payments p
        ON g.source_type IN ('payment', 'payment_void', 'payment_application', 'payment_application_void')
       AND p.id = g.source_id
      LEFT JOIN credit_memos m
        ON g.source_type IN ('credit_memo', 'credit_memo_refund', 'credit_memo_void') AND m.id = g.source_id
      LEFT JOIN deliveries d
        ON g.source_type LIKE 'delivery%' AND d.id = g.source_id
      LEFT JOIN LATERAL (
        SELECT ${auditUuid('customerId')} AS party_id,
               COALESCE(t.before_values->>'paymentNumber', t.before_values->>'invoiceNumber',
                        t.before_values->>'creditMemoNumber') AS number
          FROM audit_trail t
         WHERE i.id IS NULL AND p.id IS NULL AND m.id IS NULL AND d.id IS NULL
           AND t.company_id = g.company_id AND t.resource_id = g.source_id
           AND t.action = 'delete' AND t.resource_type IN ('payment', 'invoice', 'credit_memo')
         ORDER BY t.created_at DESC
         LIMIT 1
      ) gone ON TRUE`,
    documentType: `CASE
        WHEN g.source_type IN ('invoice', 'invoice_void') THEN 'invoice'
        WHEN g.source_type LIKE 'payment%' THEN 'payment'
        WHEN g.source_type LIKE 'credit_memo%' THEN 'credit_memo'
        WHEN g.source_type LIKE 'delivery%' THEN 'delivery'
      END`,
    documentId: `COALESCE(i.id, p.id, m.id, d.id)`,
    documentNumber: `COALESCE(i.invoice_number, p.payment_number, m.credit_memo_number, d.reference_no, gone.number)`,
    partyId: `COALESCE(i.customer_id, p.customer_id, m.customer_id, d.customer_id, gone.party_id)`,
  },
  vendor: {
    joins: `
      LEFT JOIN bills b
        ON g.source_type IN ('bill', 'bill_void') AND b.id = g.source_id
      LEFT JOIN bill_payments bp
        ON g.source_type = 'bill_payment' AND bp.id = g.source_id
      LEFT JOIN vendor_credits vc
        ON g.source_type IN ('vendor_credit', 'vendor_credit_void') AND vc.id = g.source_id
      LEFT JOIN LATERAL (
        SELECT ${auditUuid('vendorId')} AS party_id,
               COALESCE(t.before_values->>'billNumber', NULLIF(t.before_values->>'reference', ''),
                        t.before_values->>'vendorCreditNumber') AS number
          FROM audit_trail t
         WHERE b.id IS NULL AND bp.id IS NULL AND vc.id IS NULL
           AND t.company_id = g.company_id AND t.resource_id = g.source_id
           AND t.action = 'delete' AND t.resource_type IN ('bill', 'bill_payment', 'vendor_credit')
         ORDER BY t.created_at DESC
         LIMIT 1
      ) gone ON TRUE`,
    documentType: `CASE
        WHEN g.source_type IN ('bill', 'bill_void') THEN 'bill'
        WHEN g.source_type = 'bill_payment' THEN 'bill_payment'
        WHEN g.source_type IN ('vendor_credit', 'vendor_credit_void') THEN 'vendor_credit'
      END`,
    documentId: `COALESCE(b.id, bp.id, vc.id)`,
    documentNumber: `COALESCE(b.bill_number, NULLIF(bp.reference, ''), vc.vendor_credit_number, gone.number)`,
    partyId: `COALESCE(b.vendor_id, bp.vendor_id, vc.vendor_id, gone.party_id)`,
  },
};

/** One posting on a party's control account, with its document and party. */
function baseSql(type: LedgerPartyType, datePredicate: string): string {
  const s = SOURCES[type];
  return `
    SELECT g.id,
           g.date::text                                   AS date,
           g.created_at                                   AS "postedAt",
           g.reference                                    AS reference,
           je.id                                          AS "entryId",
           COALESCE(je.status = 'void', false)            AS voided,
           a.account_number                               AS "accountCode",
           a.name                                         AS "accountName",
           COALESCE(NULLIF(g.memo, ''), je.memo, '')      AS memo,
           g.debit::numeric                               AS debit,
           g.credit::numeric                              AS credit,
           g.source_type                                  AS "postingType",
           g.source_id                                    AS "sourceId",
           ${s.documentType}                              AS "documentType",
           ${s.documentId}                                AS "documentId",
           ${s.documentNumber}                            AS "documentNumber",
           ${s.partyId}                                   AS "partyId"
      FROM general_ledger g
      JOIN accounts a ON a.id = g.account_id
      LEFT JOIN journal_entries je ON je.company_id = g.company_id AND je.reference = g.reference
      ${s.joins}
     WHERE g.company_id = $1
       AND g.account_id = ANY($2::uuid[])
       AND ${datePredicate}`;
}

/**
 * The postings dated inside a period, oldest first. Within a day: in the order
 * they were recorded, then by entry number (JE-9 before JE-10), so the lines of
 * one transaction stay together.
 *
 * `$1` company, `$2` control account ids, `$3` from, `$4` to, `$5` party (when
 * `onlyParty`).
 */
export function partyRowsSql(
  type: LedgerPartyType,
  onlyParty: boolean,
): string {
  return `
    SELECT r.* FROM (${baseSql(type, 'g.date BETWEEN $3 AND $4')}) r
    ${onlyParty ? 'WHERE r."partyId" = $5' : ''}
    ORDER BY r.date, r."postedAt", length(r.reference), r.reference, r."accountCode", r.id`;
}

/**
 * Each party's balance brought forward: everything dated before the period,
 * debit-positive, with NULL for postings no party could be found for.
 *
 * `$1` company, `$2` control account ids, `$3` from, `$4` party (when `onlyParty`).
 */
export function partyOpeningSql(
  type: LedgerPartyType,
  onlyParty: boolean,
): string {
  return `
    SELECT r."partyId", SUM(r.debit - r.credit) AS balance, COUNT(*)::int AS entries
      FROM (${baseSql(type, 'g.date < $3')}) r
     ${onlyParty ? 'WHERE r."partyId" = $4' : ''}
     GROUP BY r."partyId"`;
}
