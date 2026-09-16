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
 *   ... -- --rebuild-ledger-balances   # also rebuild stored general_ledger running
 *                                      # balances (written from zero before the
 *                                      # posting fix; display data only)
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { AppModule } from '../app.module';
import { PostingService } from '../modules/journal-entries/posting.service';
import { AccountsService } from '../modules/accounts/accounts.service';
import { Company } from '../modules/companies/entities/company.entity';
import { businessToday } from '../common/utils/business-date.util';
import {
  TOLERANCE,
  customerBalanceDrift,
  ledgerRunningBalanceDrift,
  money,
  ownerOf,
  printCheck,
  rebuildLedgerRunningBalances,
  recomputeCustomerBalances,
  reclassifyLegacyReceipt,
  subledgerCheck,
} from './lib/ledger-repair';

loadEnv();

interface Args {
  apply: boolean;
  companyId: string | null;
  rebuildLedgerBalances: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    apply: false,
    companyId: null,
    rebuildLedgerBalances: false,
  };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--apply') args.apply = true;
    if (argv[i] === '--company') args.companyId = argv[i + 1] ?? null;
    if (argv[i] === '--rebuild-ledger-balances')
      args.rebuildLedgerBalances = true;
  }
  return args;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const ds = app.get(DataSource);
  const posting = app.get(PostingService);
  const accounts = app.get(AccountsService);

  console.log(
    `Customer advances repair — ${args.apply ? 'APPLY' : 'DRY RUN (nothing is written)'}`,
  );

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
    const withRemainder = legacy.filter((p) =>
      new Decimal(p.unapplied).greaterThan(TOLERANCE),
    );

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

    const drift = await customerBalanceDrift(ds, company.id);
    const ledgerDrift = args.rebuildLedgerBalances
      ? await ledgerRunningBalanceDrift(ds, company.id)
      : 0;
    if (
      withRemainder.length === 0 &&
      suspects.length === 0 &&
      drift.length === 0 &&
      ledgerDrift === 0 &&
      !args.companyId
    ) {
      continue;
    }

    console.log(`\n■ ${company.name} (${company.id})`);
    printCheck('Before', await subledgerCheck(ds, company.id));

    if (withRemainder.length) {
      console.log(
        `  Receipts holding an unapplied remainder inside A/R: ${withRemainder.length}`,
      );
      for (const p of withRemainder) {
        console.log(
          `    ${p.payment_number ?? p.id.slice(0, 8)}  ${p.payment_date}  ${p.customer_name}` +
            `  amount ${money(p.amount)}  unapplied ${money(p.unapplied)}`,
        );
      }
    }
    if (suspects.length) {
      console.log(
        '  Receipts to REVIEW as possible duplicates (not changed — delete in the app if confirmed):',
      );
      for (const s of suspects) {
        console.log(
          `    ${s.later} (${s.later_date}, ${money(s.later_amount)}, applied to ${s.invoices}) ` +
            `equals the ${money(s.remainder)} remainder of ${s.earlier} — ${s.customer}`,
        );
      }
    }

    if (drift.length) {
      console.log(
        `  Customer balances that differ from their documents (open invoices − open credit memos): ${drift.length}`,
      );
      for (const d of drift) {
        console.log(
          `    ${d.name}  stored ${money(d.stored)}  →  ${money(d.expected)}`,
        );
      }
    }
    if (args.rebuildLedgerBalances) {
      console.log(
        `  General ledger rows with a stale running balance: ${ledgerDrift}`,
      );
    }

    if (!args.apply) continue;

    const actorId = await ownerOf(ds, company.id);
    if (!actorId) {
      console.log(
        '  ! No owner account to attribute the postings to — skipped.',
      );
      continue;
    }

    const today = businessToday();
    for (const p of legacy) {
      try {
        const amount = await reclassifyLegacyReceipt(ds, posting, accounts, {
          companyId: company.id,
          paymentId: p.id,
          actorId,
          date: today,
          customerName: p.customer_name,
        });
        if (amount && new Decimal(amount).greaterThan(TOLERANCE))
          reclassified++;
      } catch (err) {
        const e = err as {
          response?: { code?: string; message?: string };
          message?: string;
        };
        console.log(
          `  ! ${p.payment_number ?? p.id.slice(0, 8)} not reclassified: ${e.response?.code ?? ''} ${e.response?.message ?? e.message}`,
        );
      }
    }

    // Balance = what each customer owes on invoices, net of open credit memos.
    const customersChanged = await recomputeCustomerBalances(ds, company.id);
    if (args.rebuildLedgerBalances) {
      const rows = await rebuildLedgerRunningBalances(ds, company.id);
      console.log(`  General ledger running balances rebuilt: ${rows} row(s)`);
    }
    const after = await subledgerCheck(ds, company.id);
    printCheck('After', after);
    console.log(`  Customer balances corrected: ${customersChanged}`);
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
