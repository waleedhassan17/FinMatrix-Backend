/**
 * Repair: move unapplied customer receipts out of Accounts Receivable
 * ====================================================================
 * Until customer advances existed, a receipt larger than the invoices it was
 * applied to credited its WHOLE amount to 1100 Accounts Receivable. The
 * remainder became a negative A/R balance tied to no invoice, with no way to
 * apply it later — which is how a second cash receipt ended up being recorded
 * to settle an invoice the first one could have covered (QA: JE-216 / JE-217,
 * and a negative A/R control account).
 *
 * For every such receipt this posts
 *
 *     Dr 1100 Accounts Receivable / Cr 2400 Customer Advances   (the remainder)
 *
 * dated today, marks the receipt advance_posted = true (so applying it later
 * posts Dr 2400 / Cr 1100 like any new receipt), and recomputes each
 * customer's balance from the subledger: open invoices − open credit memos.
 *
 * It does NOT delete anything. Receipts that look like a duplicate of an
 * earlier receipt's remainder are LISTED for the owner, who reviews them and
 * uses Delete payment (which posts a proper reversal) if they are.
 *
 * Dry run by default. Idempotent: a receipt already marked advance_posted is
 * never reclassified twice.
 *
 * Usage:
 *   npm run repair:customer-advances                         # dry run, every company
 *   npm run repair:customer-advances -- --company <uuid>     # one company
 *   npm run repair:customer-advances -- --apply              # write
 *   npm run repair:customer-advances:prod -- --apply         # compiled, production
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { AppModule } from '../app.module';
import { PostingService } from '../modules/journal-entries/posting.service';
import { AccountsService } from '../modules/accounts/accounts.service';
import { Payment } from '../modules/payments/entities/payment.entity';
import { Customer } from '../modules/customers/entities/customer.entity';
import { Company } from '../modules/companies/entities/company.entity';
import { ACCT_AR, ACCT_CUSTOMER_ADVANCES } from '../modules/accounts/accounts.constants';
import { businessToday } from '../common/utils/business-date.util';

loadEnv();

const TOLERANCE = new Decimal('0.0001');

interface Args {
  apply: boolean;
  companyId: string | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, companyId: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    if (argv[i] === '--company') args.companyId = argv[i + 1] ?? null;
  }
  return args;
}

const money = (v: Decimal.Value) => new Decimal(v ?? 0).toFixed(2);

async function subledgerCheck(ds: DataSource, companyId: string) {
  const [row] = await ds.query(
    `SELECT
       (SELECT COALESCE(balance, 0) FROM accounts WHERE company_id = $1 AND account_number = $2) AS ar_control,
       (SELECT COALESCE(balance, 0) FROM accounts WHERE company_id = $1 AND account_number = $3) AS advances,
       (SELECT COALESCE(SUM(balance), 0) FROM invoices
         WHERE company_id = $1 AND status NOT IN ('draft', 'void')) AS open_invoices,
       (SELECT COALESCE(SUM(balance), 0) FROM credit_memos
         WHERE company_id = $1 AND status <> 'void') AS open_credit_memos,
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

function printCheck(label: string, c: Awaited<ReturnType<typeof subledgerCheck>>) {
  console.log(`  ${label}`);
  console.log(`    1100 A/R control ............ ${money(c.arControl)}`);
  console.log(`    open invoices ............... ${money(c.openInvoices)}`);
  console.log(`    − open credit memos ......... ${money(c.openCreditMemos)}`);
  console.log(`    − unapplied (still in A/R) .. ${money(c.legacyUnapplied)}`);
  console.log(`    = expected A/R control ...... ${money(c.expectedArControl)}`);
  console.log(`    difference .................. ${money(c.difference)}` +
    (c.difference.abs().greaterThan('0.01')
      ? '   <-- A/R has entries no invoice, credit or receipt explains (manual journals, duplicates); review the ledger'
      : ''));
  console.log(`    2400 Customer Advances ...... ${money(c.advances)}`);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const ds = app.get(DataSource);
  const posting = app.get(PostingService);
  const accounts = app.get(AccountsService);

  console.log(`Customer advances repair — ${args.apply ? 'APPLY' : 'DRY RUN (nothing is written)'}`);

  const companies: Company[] = await ds.getRepository(Company).find({
    where: args.companyId ? { id: args.companyId } : {},
    order: { createdAt: 'ASC' } as any,
  });

  let reclassified = 0;
  for (const company of companies) {
    const legacy: Array<{
      id: string;
      payment_number: string | null;
      payment_date: string;
      customer_id: string;
      customer_name: string;
      amount: string;
      unapplied: string;
    }> = await ds.query(
      `SELECT p.id, p.payment_number, p.payment_date::text AS payment_date, p.customer_id,
              c.name AS customer_name, p.amount,
              p.amount - COALESCE(SUM(pa.amount_applied), 0) AS unapplied
         FROM payments p
         JOIN customers c ON c.id = p.customer_id
         LEFT JOIN payment_applications pa ON pa.payment_id = p.id
        WHERE p.company_id = $1 AND p.advance_posted = false
        GROUP BY p.id, c.name
        ORDER BY p.payment_date, p.created_at`,
      [company.id],
    );
    const withRemainder = legacy.filter((p) => new Decimal(p.unapplied).greaterThan(TOLERANCE));

    // A later receipt from the same customer whose amount equals an earlier
    // receipt's unapplied remainder, and which was applied to an invoice that
    // already existed when the earlier receipt was recorded.
    const suspects: Array<Record<string, string>> = await ds.query(
      `WITH remainders AS (
         SELECT p.id, p.customer_id, p.payment_date, p.created_at, p.payment_number,
                p.amount - COALESCE(SUM(pa.amount_applied), 0) AS unapplied
           FROM payments p
           LEFT JOIN payment_applications pa ON pa.payment_id = p.id
          WHERE p.company_id = $1
          GROUP BY p.id
         HAVING p.amount - COALESCE(SUM(pa.amount_applied), 0) > 0.0001
       )
       SELECT r.payment_number AS earlier, r.unapplied::text AS remainder,
              later.payment_number AS later, later.amount::text AS later_amount,
              later.payment_date::text AS later_date, c.name AS customer,
              string_agg(DISTINCT i.invoice_number, ', ') AS invoices
         FROM remainders r
         JOIN payments later
           ON later.company_id = $1
          AND later.customer_id = r.customer_id
          AND later.id <> r.id
          AND later.created_at > r.created_at
          AND ABS(later.amount - r.unapplied) <= 0.01
         JOIN payment_applications la ON la.payment_id = later.id
         JOIN invoices i ON i.id = la.invoice_id AND i.invoice_date <= r.payment_date
         JOIN customers c ON c.id = r.customer_id
        GROUP BY r.payment_number, r.unapplied, later.payment_number, later.amount,
                 later.payment_date, c.name`,
      [company.id],
    );

    if (withRemainder.length === 0 && suspects.length === 0 && !args.companyId) continue;

    console.log(`\n■ ${company.name} (${company.id})`);
    printCheck('Before', await subledgerCheck(ds, company.id));

    if (withRemainder.length) {
      console.log(`  Receipts holding an unapplied remainder inside A/R: ${withRemainder.length}`);
      for (const p of withRemainder) {
        console.log(
          `    ${p.payment_number ?? p.id.slice(0, 8)}  ${p.payment_date}  ${p.customer_name}` +
          `  amount ${money(p.amount)}  unapplied ${money(p.unapplied)}`,
        );
      }
    }
    if (suspects.length) {
      console.log('  Receipts to REVIEW as possible duplicates (not changed — delete in the app if confirmed):');
      for (const s of suspects) {
        console.log(
          `    ${s.later} (${s.later_date}, ${money(s.later_amount)}, applied to ${s.invoices}) ` +
          `equals the ${money(s.remainder)} remainder of ${s.earlier} — ${s.customer}`,
        );
      }
    }

    if (!args.apply) continue;

    const [actor]: Array<{ id: string }> = await ds.query(
      `SELECT uc.user_id AS id FROM user_companies uc
        WHERE uc.company_id = $1 AND uc.role = 'admin'
        ORDER BY uc.joined_at ASC LIMIT 1`,
      [company.id],
    );
    if (!actor) {
      console.log('  ! No owner account to attribute the postings to — skipped.');
      continue;
    }

    const today = businessToday();
    for (const p of legacy) {
      try {
        await ds.transaction(async (manager) => {
          const payment = await manager
            .createQueryBuilder(Payment, 'p')
            .setLock('pessimistic_write')
            .where('p.id = :id', { id: p.id })
            .getOne();
          if (!payment || payment.advancePosted) return;

          const [{ applied }] = await manager.query(
            `SELECT COALESCE(SUM(amount_applied), 0) AS applied FROM payment_applications WHERE payment_id = $1`,
            [payment.id],
          );
          const unapplied = new Decimal(payment.amount).minus(applied);
          if (unapplied.greaterThan(TOLERANCE)) {
            const ar = await accounts.getByNumberOrFail(company.id, ACCT_AR, manager);
            const advances = await accounts.getOrCreateSystemAccount(manager, company.id, ACCT_CUSTOMER_ADVANCES);
            const amount = unapplied.toFixed(4);
            await posting.createEntry(manager, {
              companyId: company.id,
              createdBy: actor.id,
              date: today,
              memo: `Reclassify unapplied receipt ${payment.paymentNumber ?? payment.id.slice(0, 8)} to Customer Advances — ${p.customer_name}`,
              status: 'posted',
              sourceType: 'payment_advance_reclass',
              sourceId: payment.id,
              lines: [
                { accountId: ar.id, description: 'Unapplied receipt removed from A/R', debit: amount, credit: '0', lineOrder: 0 },
                { accountId: advances.id, description: 'Held as customer advance', debit: '0', credit: amount, lineOrder: 1 },
              ],
            });
            reclassified++;
          }
          payment.advancePosted = true;
          await manager.save(payment);
        });
      } catch (err) {
        const e = err as { response?: { code?: string; message?: string }; message?: string };
        console.log(
          `  ! ${p.payment_number ?? p.id.slice(0, 8)} not reclassified: ${e.response?.code ?? ''} ${e.response?.message ?? e.message}`,
        );
      }
    }

    // Balance = what each customer owes on invoices, net of open credit memos.
    await ds.query(
      `UPDATE customers c
          SET balance = COALESCE(inv.open, 0) - COALESCE(cm.open, 0)
         FROM customers c2
         LEFT JOIN (SELECT customer_id, SUM(balance) AS open FROM invoices
                     WHERE company_id = $1 AND status NOT IN ('draft', 'void')
                     GROUP BY customer_id) inv ON inv.customer_id = c2.id
         LEFT JOIN (SELECT customer_id, SUM(balance) AS open FROM credit_memos
                     WHERE company_id = $1 AND status <> 'void'
                     GROUP BY customer_id) cm ON cm.customer_id = c2.id
        WHERE c.id = c2.id AND c.company_id = $1`,
      [company.id],
    );
    const after = await subledgerCheck(ds, company.id);
    printCheck('After', after);
    const customersTouched = await ds.getRepository(Customer).count({ where: { companyId: company.id } });
    console.log(`  Customer balances recomputed: ${customersTouched}`);
  }

  console.log(
    args.apply
      ? `\nDone. ${reclassified} receipt remainder(s) moved to Customer Advances.`
      : '\nDry run complete. Re-run with --apply to write these changes.',
  );
  await app.close();
}

run().catch((err) => {
  console.error('Repair failed:', err);
  process.exit(1);
});
