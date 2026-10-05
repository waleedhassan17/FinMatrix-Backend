import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { businessToday } from '../../common/utils/business-date.util';
import { companyFeatures } from '../../common/features/company-features.util';
import {
  normalizeAuditValue,
  sameAuditValue,
} from '../../common/audit/audit-diff.util';
import { LedgerPartyType } from './party-ledger.sql';
import { PartyLedgerService } from './party-ledger.service';

const r2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: unknown) => parseFloat(String(v ?? '0')) || 0;
const iso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : v == null ? null : String(v);
const day = (v: unknown): string | null => {
  const s = iso(v);
  return s ? s.slice(0, 10) : null;
};

/**
 * The fields of a customer or vendor whose changes the History tab lists, in
 * the order it lists them. Balance and timestamps change on every posting and
 * are not the record's history; the subscriber does not even log them.
 */
const TRACKED_FIELDS: Record<LedgerPartyType, string[]> = {
  customer: [
    'code',
    'name',
    'company',
    'contactPerson',
    'email',
    'phone',
    'taxId',
    'creditLimit',
    'paymentTerms',
    'billingAddress',
    'shippingAddress',
    'notes',
    'isActive',
  ],
  vendor: [
    'code',
    'companyName',
    'contactPerson',
    'email',
    'phone',
    'taxId',
    'paymentTerms',
    'address',
    'defaultExpenseAccountId',
    'notes',
    'isActive',
  ],
};

/** An address object as one line, the way it prints on a document. */
function addressLine(value: unknown): string | null {
  if (!value || typeof value !== 'object')
    return value == null ? null : String(value);
  const a = value as Record<string, unknown>;
  const parts = [
    a.street,
    a.city,
    a.state,
    a.postalCode ?? a.zipCode,
    a.country,
  ]
    .map((p) => (p == null ? '' : String(p).trim()))
    .filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

/** A tracked value as the History tab shows it: text, a number string or a boolean. */
function shown(field: string, value: unknown): string | boolean | null {
  if (value === undefined || value === null || value === '') return null;
  if (/address$/i.test(field)) return addressLine(value);
  if (typeof value === 'boolean') return value;
  return String(value);
}

/** Decimal fields, compared as numbers: "50000" is "50000.0000". */
const NUMERIC_FIELDS = ['creditLimit'];

/**
 * A customer's or vendor's History — Peachtree's History tab, plus who changed
 * the record.
 *
 *   • when the relationship began, the last invoice (or bill) and the last
 *     payment, and how long invoices take to be paid;
 *   • the fiscal year month by month: what was sold to them (or bought) and
 *     what was received (or paid), with the balance at each month end — from
 *     the same postings as their ledger, so the two always agree;
 *   • every change to the record, who made it and when, from audit_trail —
 *     for the owner only, as the audit trail itself is.
 */
@Injectable()
export class PartyHistoryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly ledger: PartyLedgerService,
  ) {}

  async history(
    companyId: string,
    type: LedgerPartyType,
    partyId: string,
    viewer: { role: string },
    year?: number,
  ) {
    const party = await this.ledger.party(companyId, type, partyId);
    const fiscal = await this.fiscalYear(companyId, year);
    const { opening, rows } = await this.ledger.rows(
      companyId,
      type,
      { startDate: fiscal.startDate, endDate: fiscal.endDate },
      partyId,
    );

    // What the party owes (customer) or is owed (vendor), going up.
    const sign = type === 'customer' ? 1 : -1;
    const months = fiscal.months.map((month) => ({
      month,
      charged: 0,
      settled: 0,
      balance: 0,
    }));
    const index = new Map(months.map((m, i) => [m.month, i]));
    for (const r of rows) {
      const m = months[index.get(r.date.slice(0, 7)) ?? -1];
      if (!m) continue;
      const amount = sign * (r.debit - r.credit);
      if (isCharge(type, r.postingType)) m.charged += amount;
      else m.settled -= amount;
    }
    let balance = r2(sign * (opening.get(partyId) ?? 0));
    const openingBalance = balance;
    for (const m of months) {
      m.charged = r2(m.charged);
      m.settled = r2(m.settled);
      balance = r2(balance + m.charged - m.settled);
      m.balance = balance;
    }

    const [facts, changes] = await Promise.all([
      this.facts(companyId, type, partyId, party.createdAt),
      this.changes(companyId, type, partyId, party.createdAt, viewer),
    ]);

    const charged = r2(months.reduce((t, m) => t + m.charged, 0));
    const settled = r2(months.reduce((t, m) => t + m.settled, 0));
    return {
      partyType: type,
      party: { id: party.id, code: party.code, name: party.name },
      ...facts,
      fiscalYear: {
        year: fiscal.year,
        startDate: fiscal.startDate,
        endDate: fiscal.endDate,
      },
      openingBalance,
      // Customers: sales and receipts. Vendors: purchases and payments.
      months: months.map((m) =>
        type === 'customer'
          ? {
              month: m.month,
              sales: m.charged,
              receipts: m.settled,
              balance: m.balance,
            }
          : {
              month: m.month,
              purchases: m.charged,
              payments: m.settled,
              balance: m.balance,
            },
      ),
      totals:
        type === 'customer'
          ? { sales: charged, receipts: settled }
          : { purchases: charged, payments: settled },
      closingBalance: balance,
      changes,
    };
  }

  /**
   * The fiscal year `year` starts in, or the one today falls in. A company that
   * starts its year in July has fiscal 2026 run July 2026 – June 2027.
   */
  private async fiscalYear(companyId: string, year?: number) {
    const [row] = await this.dataSource.query(
      `SELECT c.fiscal_year_start_month AS month, s.fiscal_year_start AS start
         FROM companies c
         LEFT JOIN company_settings s ON s.company_id = c.id
        WHERE c.id = $1
        LIMIT 1`,
      [companyId],
    );
    const fromSettings = parseInt(String(row?.start ?? '').slice(0, 2), 10);
    const startMonth = clampMonth(num(row?.month) || fromSettings || 1);

    const today = businessToday();
    const [ty, tm] = [
      parseInt(today.slice(0, 4), 10),
      parseInt(today.slice(5, 7), 10),
    ];
    const current = tm >= startMonth ? ty : ty - 1;
    const fy = year && year > 1900 && year < 3000 ? year : current;

    const months: string[] = [];
    for (let i = 0; i < 12; i++) {
      const m0 = startMonth - 1 + i;
      months.push(
        `${fy + Math.floor(m0 / 12)}-${String((m0 % 12) + 1).padStart(2, '0')}`,
      );
    }
    const startDate = `${months[0]}-01`;
    const last = months[11];
    const lastDay = new Date(
      Date.UTC(
        parseInt(last.slice(0, 4), 10),
        parseInt(last.slice(5, 7), 10),
        0,
      ),
    )
      .toISOString()
      .slice(0, 10);
    return { year: fy, startMonth, startDate, endDate: lastDay, months };
  }

  /** Peachtree's history figures: since when, the last of each, days to pay. */
  private async facts(
    companyId: string,
    type: LedgerPartyType,
    partyId: string,
    createdAt: string,
  ) {
    if (type === 'customer') {
      const [[first], [lastInvoice], [lastPayment], [pay]] = await Promise.all([
        this.dataSource.query(
          `SELECT LEAST(
                    (SELECT MIN(invoice_date) FROM invoices
                      WHERE company_id = $1 AND customer_id = $2 AND status NOT IN ('draft', 'void')),
                    (SELECT MIN(payment_date) FROM payments WHERE company_id = $1 AND customer_id = $2)
                  )::text AS first`,
          [companyId, partyId],
        ),
        this.dataSource.query(
          `SELECT id, invoice_number AS number, invoice_date::text AS date, total::numeric AS amount
             FROM invoices
            WHERE company_id = $1 AND customer_id = $2 AND status NOT IN ('draft', 'void')
            ORDER BY invoice_date DESC, created_at DESC, id DESC
            LIMIT 1`,
          [companyId, partyId],
        ),
        this.dataSource.query(
          `SELECT id, payment_number AS number, payment_date::text AS date, amount::numeric AS amount
             FROM payments
            WHERE company_id = $1 AND customer_id = $2
            ORDER BY payment_date DESC, created_at DESC, id DESC
            LIMIT 1`,
          [companyId, partyId],
        ),
        // Invoices settled in full by receipts over the last year: from the
        // invoice date to the day its last receipt was applied.
        this.dataSource.query(
          `WITH settled AS (
             SELECT i.id, i.invoice_date,
                    MAX(COALESCE(pa.applied_on::date, p.payment_date)) AS paid_on
               FROM invoices i
               JOIN payment_applications pa ON pa.invoice_id = i.id
               JOIN payments p ON p.id = pa.payment_id
              WHERE i.company_id = $1 AND i.customer_id = $2 AND i.status = 'paid'
              GROUP BY i.id, i.invoice_date
           )
           SELECT AVG(GREATEST(paid_on - invoice_date, 0))::numeric AS days, COUNT(*)::int AS count
             FROM settled
            WHERE paid_on >= CAST($3 AS date) - 365`,
          [companyId, partyId, businessToday()],
        ),
      ]);
      return {
        since: earliest(day(createdAt), first?.first ?? null),
        lastInvoice: lastInvoice ? document(lastInvoice) : null,
        lastPayment: lastPayment ? document(lastPayment) : null,
        averageDaysToPay: pay?.count
          ? { days: Math.round(num(pay.days)), count: pay.count }
          : null,
      };
    }

    const [[first], [lastBill], [lastPayment], [pay]] = await Promise.all([
      this.dataSource.query(
        `SELECT LEAST(
                  (SELECT MIN(bill_date) FROM bills
                    WHERE company_id = $1 AND vendor_id = $2 AND status NOT IN ('draft', 'void')),
                  (SELECT MIN(payment_date) FROM bill_payments WHERE company_id = $1 AND vendor_id = $2)
                )::text AS first`,
        [companyId, partyId],
      ),
      this.dataSource.query(
        `SELECT id, bill_number AS number, bill_date::text AS date, total::numeric AS amount
           FROM bills
          WHERE company_id = $1 AND vendor_id = $2 AND status NOT IN ('draft', 'void')
          ORDER BY bill_date DESC, created_at DESC, id DESC
          LIMIT 1`,
        [companyId, partyId],
      ),
      this.dataSource.query(
        `SELECT id, NULLIF(reference, '') AS number, payment_date::text AS date,
                total_amount::numeric AS amount
           FROM bill_payments
          WHERE company_id = $1 AND vendor_id = $2
          ORDER BY payment_date DESC, created_at DESC, id DESC
          LIMIT 1`,
        [companyId, partyId],
      ),
      this.dataSource.query(
        `WITH settled AS (
           SELECT b.id, b.bill_date, MAX(bp.payment_date) AS paid_on
             FROM bills b
             JOIN bill_payment_applications a ON a.bill_id = b.id
             JOIN bill_payments bp ON bp.id = a.bill_payment_id
            WHERE b.company_id = $1 AND b.vendor_id = $2 AND b.status = 'paid'
            GROUP BY b.id, b.bill_date
         )
         SELECT AVG(GREATEST(paid_on - bill_date, 0))::numeric AS days, COUNT(*)::int AS count
           FROM settled
          WHERE paid_on >= CAST($3 AS date) - 365`,
        [companyId, partyId, businessToday()],
      ),
    ]);
    return {
      since: earliest(day(createdAt), first?.first ?? null),
      lastBill: lastBill ? document(lastBill) : null,
      lastPayment: lastPayment ? document(lastPayment) : null,
      averageDaysToPay: pay?.count
        ? { days: Math.round(num(pay.days)), count: pay.count }
        : null,
    };
  }

  /**
   * Who changed the record, newest first: the owner sees it when the company's
   * plan has the audit log; anyone else gets `null`, which the clients read as
   * "not shown". A record older than the log gets a "created" line from its
   * own creation date, with nobody named.
   */
  private async changes(
    companyId: string,
    type: LedgerPartyType,
    partyId: string,
    createdAt: string,
    viewer: { role: string },
  ) {
    if (viewer.role !== 'admin' && viewer.role !== 'super_admin') return null;
    const features = await companyFeatures(this.dataSource.manager, companyId);
    if (!features.auditLog) return null;

    const rows: any[] = await this.dataSource.query(
      `SELECT t.id, t.action, t.created_at AS at, t.before_values AS before, t.after_values AS after,
              t.user_id AS "userId", COALESCE(NULLIF(u.display_name, ''), u.username, u.email) AS "userName"
         FROM audit_trail t
         LEFT JOIN users u ON u.id = t.user_id
        WHERE t.company_id = $1 AND t.resource_type = $2 AND t.resource_id = $3
        ORDER BY t.created_at DESC
        LIMIT 200`,
      [companyId, type, partyId],
    );

    const fields = TRACKED_FIELDS[type];
    const out = rows.map((r) => {
      const before = (r.before ?? {}) as Record<string, unknown>;
      const after = (r.after ?? {}) as Record<string, unknown>;
      const changed =
        r.action === 'create'
          ? // What it was created with — leaving out the blanks, a zero credit
            // limit and the active flag every new record has.
            fields
              .filter((f) => f !== 'isActive' && shown(f, after[f]) !== null)
              .filter(
                (f) =>
                  !(
                    NUMERIC_FIELDS.includes(f) &&
                    normalizeAuditValue(after[f], true) === 0
                  ),
              )
              .map((f) => ({ field: f, from: null, to: shown(f, after[f]) }))
          : fields
              .filter(
                (f) =>
                  !sameAuditValue(
                    before[f],
                    after[f],
                    NUMERIC_FIELDS.includes(f),
                  ),
              )
              .map((f) => ({
                field: f,
                from: shown(f, before[f]),
                to: shown(f, after[f]),
              }));
      return {
        id: r.id,
        at: iso(r.at),
        action: actionOf(r.action, before, after),
        user: r.userId ? { id: r.userId, name: r.userName ?? null } : null,
        fields: changed,
      };
    });
    if (!rows.some((r) => r.action === 'create')) {
      out.push({
        id: `created-${partyId}`,
        at: createdAt,
        action: 'created',
        user: null,
        fields: [],
      });
    }
    return out;
  }
}

/** Whether a posting is a sale or purchase (rather than money in or out). */
function isCharge(type: LedgerPartyType, postingType: string): boolean {
  return (type === 'customer' ? CUSTOMER_CHARGES : VENDOR_CHARGES).includes(
    postingType,
  );
}

/** Sales are invoices less credit memos; a refund is money paid back, not a sale. */
const CUSTOMER_CHARGES = [
  'invoice',
  'invoice_void',
  'credit_memo',
  'credit_memo_void',
];
const VENDOR_CHARGES = [
  'bill',
  'bill_void',
  'vendor_credit',
  'vendor_credit_void',
];

/** Peachtree words for the record's own events. */
function actionOf(
  action: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): string {
  if (action === 'create') return 'created';
  if (action === 'delete') return 'deleted';
  if (before.isActive === true && after.isActive === false)
    return 'deactivated';
  if (before.isActive === false && after.isActive === true)
    return 'reactivated';
  return 'updated';
}

function clampMonth(m: number): number {
  return Math.min(12, Math.max(1, Math.round(m)));
}

function earliest(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

function document(row: any) {
  return {
    id: row.id,
    number: row.number ?? null,
    date: row.date ?? null,
    amount: r2(num(row.amount)),
  };
}
