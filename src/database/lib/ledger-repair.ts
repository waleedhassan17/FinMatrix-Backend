/**
 * Shared steps for one-off ledger repairs.
 *
 * Kept free of script concerns (argument parsing, printing) so the advances
 * repair and receipt corrections post and recompute in exactly the same way.
 */
import { DataSource, EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { PostingService } from '../../modules/journal-entries/posting.service';
import { AccountsService } from '../../modules/accounts/accounts.service';
import { Payment } from '../../modules/payments/entities/payment.entity';
import {
  ACCT_AR,
  ACCT_CUSTOMER_ADVANCES,
} from '../../modules/accounts/accounts.constants';

export const TOLERANCE = new Decimal('0.0001');

export const money = (v: Decimal.Value) => new Decimal(v ?? 0).toFixed(2);

/** A/R control against the subledger it summarises. */
export async function subledgerCheck(
  ds: DataSource | EntityManager,
  companyId: string,
) {
  const [row] = await ds.query(
    `SELECT
       (SELECT COALESCE(balance, 0) FROM accounts WHERE company_id = $1 AND account_number = $2) AS ar_control,
       (SELECT COALESCE(balance, 0) FROM accounts WHERE company_id = $1 AND account_number = $3) AS advances,
       (SELECT COALESCE(SUM(balance), 0) FROM invoices
         WHERE company_id = $1 AND status NOT IN ('draft', 'void')) AS open_invoices,
       (SELECT COALESCE(SUM(balance), 0) FROM credit_memos
         WHERE company_id = $1 AND status NOT IN ('draft', 'void')) AS open_credit_memos,
       (SELECT COALESCE(SUM(p.amount - COALESCE(a.applied, 0)), 0)
          FROM payments p
          LEFT JOIN (SELECT payment_id, SUM(amount_applied) AS applied
                       FROM payment_applications GROUP BY payment_id) a ON a.payment_id = p.id
         WHERE p.company_id = $1 AND p.advance_posted = false
           AND p.amount - COALESCE(a.applied, 0) > 0) AS legacy_unapplied`,
    [companyId, ACCT_AR, ACCT_CUSTOMER_ADVANCES],
  );
  const expected = new Decimal(row.open_invoices)
    .minus(row.open_credit_memos)
    .minus(row.legacy_unapplied);
  return {
    arControl: new Decimal(row.ar_control),
    advances: new Decimal(row.advances),
    openInvoices: new Decimal(row.open_invoices),
    openCreditMemos: new Decimal(row.open_credit_memos),
    legacyUnapplied: new Decimal(row.legacy_unapplied),
    expectedArControl: expected,
    difference: new Decimal(row.ar_control).minus(expected),
  };
}

export function printCheck(
  label: string,
  c: Awaited<ReturnType<typeof subledgerCheck>>,
) {
  console.log(`  ${label}`);
  console.log(`    1100 A/R control ............ ${money(c.arControl)}`);
  console.log(`    open invoices ............... ${money(c.openInvoices)}`);
  console.log(`    − open credit memos ......... ${money(c.openCreditMemos)}`);
  console.log(`    − unapplied (still in A/R) .. ${money(c.legacyUnapplied)}`);
  console.log(
    `    = expected A/R control ...... ${money(c.expectedArControl)}`,
  );
  console.log(
    `    difference .................. ${money(c.difference)}` +
      (c.difference.abs().greaterThan('0.01')
        ? '   <-- A/R has entries no invoice, credit or receipt explains; review the ledger'
        : ''),
  );
  console.log(`    2400 Customer Advances ...... ${money(c.advances)}`);
}

/** The company's first owner, to attribute repair postings to. */
export async function ownerOf(
  ds: DataSource,
  companyId: string,
): Promise<string | null> {
  const [actor]: Array<{ id: string }> = await ds.query(
    `SELECT uc.user_id AS id FROM user_companies uc
      WHERE uc.company_id = $1 AND uc.role = 'admin'
      ORDER BY uc.joined_at ASC LIMIT 1`,
    [companyId],
  );
  return actor?.id ?? null;
}

/**
 * Move a legacy receipt's unapplied remainder out of A/R:
 * Dr 1100 Accounts Receivable / Cr 2400 Customer Advances, then mark the
 * receipt advance_posted so applying it later posts Dr 2400 / Cr 1100.
 *
 * Returns the amount reclassified ('0.0000' when there was none), or null when
 * the receipt was already advance_posted (nothing to do).
 */
export async function reclassifyLegacyReceipt(
  ds: DataSource,
  posting: PostingService,
  accounts: AccountsService,
  opts: {
    companyId: string;
    paymentId: string;
    actorId: string;
    date: string;
    customerName: string;
  },
): Promise<string | null> {
  return ds.transaction(async (manager) => {
    const payment = await manager
      .createQueryBuilder(Payment, 'p')
      .setLock('pessimistic_write')
      .where('p.id = :id AND p.companyId = :companyId', {
        id: opts.paymentId,
        companyId: opts.companyId,
      })
      .getOne();
    if (!payment || payment.advancePosted) return null;

    const [{ applied }] = await manager.query(
      `SELECT COALESCE(SUM(amount_applied), 0) AS applied FROM payment_applications WHERE payment_id = $1`,
      [payment.id],
    );
    const unapplied = new Decimal(payment.amount).minus(applied);
    if (unapplied.greaterThan(TOLERANCE)) {
      const ar = await accounts.getByNumberOrFail(
        opts.companyId,
        ACCT_AR,
        manager,
      );
      const advances = await accounts.getOrCreateSystemAccount(
        manager,
        opts.companyId,
        ACCT_CUSTOMER_ADVANCES,
      );
      const amount = unapplied.toFixed(4);
      await posting.createEntry(manager, {
        companyId: opts.companyId,
        createdBy: opts.actorId,
        date: opts.date,
        memo: `Reclassify unapplied receipt ${payment.paymentNumber ?? payment.id.slice(0, 8)} to Customer Advances — ${opts.customerName}`,
        status: 'posted',
        sourceType: 'payment_advance_reclass',
        sourceId: payment.id,
        lines: [
          {
            accountId: ar.id,
            description: 'Unapplied receipt removed from A/R',
            debit: amount,
            credit: '0',
            lineOrder: 0,
          },
          {
            accountId: advances.id,
            description: 'Held as customer advance',
            debit: '0',
            credit: amount,
            lineOrder: 1,
          },
        ],
      });
    }
    payment.advancePosted = true;
    await manager.save(payment);
    return unapplied.greaterThan(TOLERANCE) ? unapplied.toFixed(4) : '0.0000';
  });
}

/**
 * Stored customer balances that differ from their documents: what each
 * customer owes on invoices, net of open credit memos.
 */
export async function customerBalanceDrift(ds: DataSource, companyId: string) {
  return (await ds.query(
    `SELECT c.id, c.name, c.balance::text AS stored,
            (COALESCE(inv.open, 0) - COALESCE(cm.open, 0))::text AS expected
       FROM customers c
       LEFT JOIN (SELECT customer_id, SUM(balance) AS open FROM invoices
                   WHERE company_id = $1 AND status NOT IN ('draft', 'void')
                   GROUP BY customer_id) inv ON inv.customer_id = c.id
       LEFT JOIN (SELECT customer_id, SUM(balance) AS open FROM credit_memos
                   WHERE company_id = $1 AND status NOT IN ('draft', 'void')
                   GROUP BY customer_id) cm ON cm.customer_id = c.id
      WHERE c.company_id = $1
        AND ABS(c.balance - (COALESCE(inv.open, 0) - COALESCE(cm.open, 0))) > 0.005
      ORDER BY c.name`,
    [companyId],
  )) as Array<{ id: string; name: string; stored: string; expected: string }>;
}

/** Set every customer's stored balance from its documents. Returns rows changed. */
export async function recomputeCustomerBalances(
  ds: DataSource,
  companyId: string,
): Promise<number> {
  const raw = await ds.query(
    `UPDATE customers c
        SET balance = x.expected
       FROM (SELECT c2.id, COALESCE(inv.open, 0) - COALESCE(cm.open, 0) AS expected
               FROM customers c2
               LEFT JOIN (SELECT customer_id, SUM(balance) AS open FROM invoices
                           WHERE company_id = $1 AND status NOT IN ('draft', 'void')
                           GROUP BY customer_id) inv ON inv.customer_id = c2.id
               LEFT JOIN (SELECT customer_id, SUM(balance) AS open FROM credit_memos
                           WHERE company_id = $1 AND status NOT IN ('draft', 'void')
                           GROUP BY customer_id) cm ON cm.customer_id = c2.id
              WHERE c2.company_id = $1) x
      WHERE c.id = x.id AND ABS(c.balance - x.expected) > 0.00005`,
    [companyId],
  );
  // UPDATE comes back from TypeORM as [rows, rowCount].
  return Array.isArray(raw) && typeof raw[1] === 'number' ? raw[1] : 0;
}

/**
 * Running balances on general_ledger rows that disagree with a rebuild.
 *
 * The rebuild walks each account's rows in posting order (created_at, id) and
 * accumulates the signed movement (debit-normal for assets and expenses,
 * credit-normal otherwise), anchored so the last row equals the account's
 * balance. Only the stored running figure changes; no posting is touched.
 */
const RUNNING_SQL = `
  WITH ordered AS (
    SELECT g.id, g.account_id, g.balance AS stored,
           SUM(CASE WHEN a.type IN ('asset', 'expense') THEN g.debit - g.credit
                    ELSE g.credit - g.debit END)
             OVER (PARTITION BY g.account_id ORDER BY g.created_at, g.id
                   ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS cumulative,
           SUM(CASE WHEN a.type IN ('asset', 'expense') THEN g.debit - g.credit
                    ELSE g.credit - g.debit END)
             OVER (PARTITION BY g.account_id) AS total,
           a.balance AS account_balance
      FROM general_ledger g
      JOIN accounts a ON a.id = g.account_id
     WHERE g.company_id = $1
  )
  SELECT id, stored, (account_balance - total + cumulative)::numeric(18,4) AS rebuilt
    FROM ordered`;

export async function ledgerRunningBalanceDrift(
  ds: DataSource,
  companyId: string,
): Promise<number> {
  const [row] = await ds.query(
    `SELECT COUNT(*)::int AS n FROM (${RUNNING_SQL}) r WHERE ABS(r.stored - r.rebuilt) > 0.00005`,
    [companyId],
  );
  return row?.n ?? 0;
}

export async function rebuildLedgerRunningBalances(
  ds: DataSource,
  companyId: string,
): Promise<number> {
  const raw = await ds.query(
    `UPDATE general_ledger g
        SET balance = r.rebuilt
       FROM (${RUNNING_SQL}) r
      WHERE g.id = r.id AND ABS(r.stored - r.rebuilt) > 0.00005`,
    [companyId],
  );
  return Array.isArray(raw) && typeof raw[1] === 'number' ? raw[1] : 0;
}
