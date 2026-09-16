/**
 * Correction: Allama Iqbal receipts of 15 Sep 2026 (Warehouse Co)
 * ================================================================
 * Recorded before customer advances existed:
 *
 *   RCT-2026-0036  107,250  applied 1,200 to INV-2026-0048  — JE-216 credited A/R
 *                                                             the whole 107,250
 *   RCT-2026-0037  106,050  applied to INV-2026-0048        — JE-217, a DUPLICATE:
 *                                                             the customer paid once
 *   RCT-2026-0038    6,864  applied 3,100 to INV-2026-0049  — JE-219 credited A/R
 *                                                             the whole 6,864
 *
 * A/R control was 109,814 below the subledger, Cash 106,050 too high, and the
 * customer's balance read −99,226.40. The owner confirmed RCT-0037 is a
 * duplicate and that RCT-0038 was meant to settle INV-0049.
 *
 * Steps (each atomic, each skipped when already done, so a re-run resumes):
 *   1. Reclassify the unapplied remainders of RCT-0036 (106,050) and RCT-0038
 *      (3,764): Dr 1100 A/R / Cr 2400 Customer Advances.
 *   2. Reverse the duplicate RCT-0037 through PaymentsService.delete:
 *      INV-0048 un-applied by 106,050 and JE-217 mirrored (Dr 1100 / Cr 1000).
 *   3. Settle INV-0048 from RCT-0036's advance: Dr 2400 / Cr 1100 106,050.
 *   4. Settle INV-0049 from RCT-0038's advance: Dr 2400 / Cr 1100 3,764.
 *   5. Recompute every Warehouse Co customer's stored balance from documents.
 *   6. Rebuild the stored general_ledger running balances (display data).
 *
 * Every precondition is checked before anything is written; the script
 * refuses to run against data that is not what was audited.
 *
 * Usage:
 *   npm run correct:allama-receipts            # dry run
 *   npm run correct:allama-receipts -- --apply
 *   npm run correct:allama-receipts:prod [-- --apply]
 */
import 'reflect-metadata';
import { config as loadEnv } from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { AppModule } from '../app.module';
import { PostingService } from '../modules/journal-entries/posting.service';
import { AccountsService } from '../modules/accounts/accounts.service';
import { PaymentsService } from '../modules/payments/payments.service';
import { businessToday } from '../common/utils/business-date.util';
import {
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

const SPEC = {
  companyId: 'c2bd2a9e-a7bd-44ed-9573-c7001341ab3f',
  companyName: 'Warehouse Co',
  customerId: '40eed113-7d4b-4c0b-8c7a-2f738e10f914',
  customerName: 'Allama Iqbal',
  original: { number: 'RCT-2026-0036', amount: '107250', remainder: '106050' },
  duplicate: { number: 'RCT-2026-0037', amount: '106050', journal: 'JE-217' },
  partial: { number: 'RCT-2026-0038', amount: '6864', remainder: '3764' },
  settled: { number: 'INV-2026-0048', total: '107250' },
  shortPaid: { number: 'INV-2026-0049', total: '6864' },
};

const eq = (a: Decimal.Value, b: Decimal.Value) =>
  new Decimal(a).minus(b).abs().lessThan('0.005');

interface PaymentRow {
  id: string;
  payment_number: string;
  customer_id: string;
  amount: string;
  advance_posted: boolean;
  applied: string;
}
interface InvoiceRow {
  id: string;
  invoice_number: string;
  customer_id: string;
  total: string;
  balance: string;
  status: string;
}

class PreconditionError extends Error {}
const need = (ok: boolean, message: string) => {
  if (!ok) throw new PreconditionError(message);
};

async function load(ds: DataSource) {
  const payments: PaymentRow[] = await ds.query(
    `SELECT p.id, p.payment_number, p.customer_id, p.amount::text, p.advance_posted,
            COALESCE((SELECT SUM(amount_applied) FROM payment_applications pa WHERE pa.payment_id = p.id), 0)::text AS applied
       FROM payments p WHERE p.company_id = $1 AND p.payment_number = ANY($2)`,
    [
      SPEC.companyId,
      [SPEC.original.number, SPEC.duplicate.number, SPEC.partial.number],
    ],
  );
  const invoices: InvoiceRow[] = await ds.query(
    `SELECT id, invoice_number, customer_id, total::text, balance::text, status
       FROM invoices WHERE company_id = $1 AND invoice_number = ANY($2)`,
    [SPEC.companyId, [SPEC.settled.number, SPEC.shortPaid.number]],
  );
  const pay = (n: string) => payments.find((p) => p.payment_number === n);
  const inv = (n: string) => invoices.find((i) => i.invoice_number === n);
  return {
    original: pay(SPEC.original.number),
    duplicate: pay(SPEC.duplicate.number),
    partial: pay(SPEC.partial.number),
    settled: inv(SPEC.settled.number),
    shortPaid: inv(SPEC.shortPaid.number),
  };
}

async function checkPreconditions(ds: DataSource) {
  const [company] = await ds.query(`SELECT name FROM companies WHERE id = $1`, [
    SPEC.companyId,
  ]);
  need(
    company?.name === SPEC.companyName,
    `Company ${SPEC.companyId} is not "${SPEC.companyName}".`,
  );
  const [customer] = await ds.query(
    `SELECT name FROM customers WHERE id = $1 AND company_id = $2`,
    [SPEC.customerId, SPEC.companyId],
  );
  need(
    customer?.name === SPEC.customerName,
    `Customer is not "${SPEC.customerName}".`,
  );

  const s = await load(ds);
  for (const [label, row] of [
    ['original', s.original],
    ['partial', s.partial],
  ] as const) {
    need(!!row, `${SPEC[label].number} not found.`);
    need(
      row!.customer_id === SPEC.customerId,
      `${SPEC[label].number} is not ${SPEC.customerName}'s.`,
    );
    need(
      eq(row!.amount, SPEC[label].amount),
      `${SPEC[label].number} amount ${row!.amount} ≠ ${SPEC[label].amount}.`,
    );
  }
  for (const [label, row] of [
    ['settled', s.settled],
    ['shortPaid', s.shortPaid],
  ] as const) {
    need(!!row, `${SPEC[label].number} not found.`);
    need(
      row!.customer_id === SPEC.customerId,
      `${SPEC[label].number} is not ${SPEC.customerName}'s.`,
    );
    need(
      eq(row!.total, SPEC[label].total),
      `${SPEC[label].number} total ${row!.total} ≠ ${SPEC[label].total}.`,
    );
  }

  if (s.duplicate) {
    need(
      s.duplicate.customer_id === SPEC.customerId,
      `${SPEC.duplicate.number} is not ${SPEC.customerName}'s.`,
    );
    need(
      eq(s.duplicate.amount, SPEC.duplicate.amount),
      `${SPEC.duplicate.number} amount changed.`,
    );
    const apps = await ds.query(
      `SELECT i.invoice_number, pa.amount_applied::text AS amount
         FROM payment_applications pa JOIN invoices i ON i.id = pa.invoice_id
        WHERE pa.payment_id = $1`,
      [s.duplicate.id],
    );
    need(
      apps.length === 1 &&
        apps[0].invoice_number === SPEC.settled.number &&
        eq(apps[0].amount, SPEC.duplicate.amount),
      `${SPEC.duplicate.number} is no longer applied only to ${SPEC.settled.number}.`,
    );
    const [{ n }] = await ds.query(
      `SELECT COUNT(*)::int AS n FROM general_ledger WHERE source_id = $1 AND reconciliation_id IS NOT NULL`,
      [s.duplicate.id],
    );
    need(
      n === 0,
      `${SPEC.duplicate.number} is bank-reconciled; undo the reconciliation first.`,
    );
  }
  return s;
}

/** What steps 1–4 would do against the current state, as journal lines. */
function planSteps(s: Awaited<ReturnType<typeof load>>) {
  const steps: Array<{ title: string; lines: string[]; skip?: string }> = [];
  const unapplied = (p: PaymentRow) => new Decimal(p.amount).minus(p.applied);

  for (const p of [s.original!, s.partial!]) {
    steps.push(
      p.advance_posted
        ? {
            title: `1. Reclassify ${p.payment_number} remainder`,
            lines: [],
            skip: 'already reclassified',
          }
        : {
            title: `1. Reclassify ${p.payment_number} remainder`,
            lines: [
              `Dr 1100 Accounts Receivable      ${money(unapplied(p))}`,
              `   Cr 2400 Customer Advances        ${money(unapplied(p))}`,
            ],
          },
    );
  }

  let settledBalance = new Decimal(s.settled!.balance);
  if (s.duplicate) {
    steps.push({
      title: `2. Reverse duplicate ${SPEC.duplicate.number} (mirror of ${SPEC.duplicate.journal})`,
      lines: [
        `Dr 1100 Accounts Receivable      ${money(s.duplicate.amount)}`,
        `   Cr 1000 Cash                     ${money(s.duplicate.amount)}`,
        `${SPEC.settled.number} balance ${money(settledBalance)} → ${money(settledBalance.plus(s.duplicate.applied))}`,
      ],
    });
    settledBalance = settledBalance.plus(s.duplicate.applied);
  } else {
    steps.push({
      title: `2. Reverse duplicate ${SPEC.duplicate.number}`,
      lines: [],
      skip: 'already reversed',
    });
  }

  const pairs: Array<[PaymentRow, InvoiceRow, Decimal, string]> = [
    [s.original!, s.settled!, settledBalance, SPEC.original.remainder],
    [
      s.partial!,
      s.shortPaid!,
      new Decimal(s.shortPaid!.balance),
      SPEC.partial.remainder,
    ],
  ];
  for (const [p, i, balance, expected] of pairs) {
    const title = `${p === s.original ? 3 : 4}. Apply ${p.payment_number} advance to ${i.invoice_number}`;
    if (balance.lessThan('0.005')) {
      steps.push({
        title,
        lines: [],
        skip: `${i.invoice_number} already paid`,
      });
      continue;
    }
    need(
      eq(balance, expected),
      `${i.invoice_number} would owe ${money(balance)}, expected ${money(expected)}.`,
    );
    need(
      unapplied(p).greaterThanOrEqualTo(new Decimal(expected).minus('0.005')),
      `${p.payment_number} holds only ${money(unapplied(p))} unapplied.`,
    );
    steps.push({
      title,
      lines: [
        `Dr 2400 Customer Advances        ${money(expected)}`,
        `   Cr 1100 Accounts Receivable      ${money(expected)}`,
        `${i.invoice_number} balance ${money(balance)} → 0.00 (paid)`,
      ],
    });
  }
  return steps;
}

async function run() {
  const apply = process.argv.includes('--apply');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error', 'warn'],
  });
  const ds = app.get(DataSource);
  const posting = app.get(PostingService);
  const accounts = app.get(AccountsService);
  const payments = app.get(PaymentsService);

  console.log(
    `Allama Iqbal receipt correction — ${apply ? 'APPLY' : 'DRY RUN (nothing is written)'}`,
  );
  console.log(`Business date: ${businessToday()}\n`);

  try {
    const state = await checkPreconditions(ds);
    printCheck('Before', await subledgerCheck(ds, SPEC.companyId));

    const steps = planSteps(state);
    for (const step of steps) {
      console.log(
        `\n  ${step.title}${step.skip ? `  — skipped: ${step.skip}` : ''}`,
      );
      for (const l of step.lines) console.log(`      ${l}`);
    }
    const drift = await customerBalanceDrift(ds, SPEC.companyId);
    console.log(`\n  5. Customer balances to correct: ${drift.length}`);
    for (const d of drift)
      console.log(
        `      ${d.name}  ${money(d.stored)} → ${money(d.expected)} (before steps 1–4)`,
      );
    console.log(
      `\n  6. General ledger running balances to rebuild: ${await ledgerRunningBalanceDrift(ds, SPEC.companyId)} row(s)`,
    );

    if (!apply) {
      console.log(
        '\nDry run complete. Re-run with --apply to post these corrections.',
      );
      return;
    }

    const actorId = await ownerOf(ds, SPEC.companyId);
    need(!!actorId, 'No owner account to attribute the postings to.');
    const today = businessToday();

    for (const p of [state.original!, state.partial!]) {
      const amount = await reclassifyLegacyReceipt(ds, posting, accounts, {
        companyId: SPEC.companyId,
        paymentId: p.id,
        actorId: actorId!,
        date: today,
        customerName: SPEC.customerName,
      });
      console.log(
        `  ✓ ${p.payment_number}: ${amount === null ? 'already reclassified' : `reclassified ${money(amount)}`}`,
      );
    }

    if (state.duplicate) {
      await payments.delete(SPEC.companyId, state.duplicate.id, actorId!);
      console.log(`  ✓ ${SPEC.duplicate.number} reversed`);
    }

    // Re-read: the reversal re-opened INV-0048.
    const fresh = await load(ds);
    for (const [p, i, expected] of [
      [fresh.original!, fresh.settled!, SPEC.original.remainder],
      [fresh.partial!, fresh.shortPaid!, SPEC.partial.remainder],
    ] as const) {
      if (new Decimal(i.balance).lessThan('0.005')) {
        console.log(`  ✓ ${i.invoice_number} already paid`);
        continue;
      }
      need(
        eq(i.balance, expected),
        `${i.invoice_number} owes ${money(i.balance)}, expected ${money(expected)}; stopped.`,
      );
      await payments.apply(SPEC.companyId, actorId!, p.id, {
        applications: [
          { invoiceId: i.id, amount: new Decimal(expected).toFixed(4) },
        ],
      });
      console.log(
        `  ✓ ${money(expected)} of ${p.payment_number} applied to ${i.invoice_number}`,
      );
    }

    const changed = await recomputeCustomerBalances(ds, SPEC.companyId);
    console.log(`  ✓ customer balances corrected: ${changed}`);
    const rows = await rebuildLedgerRunningBalances(ds, SPEC.companyId);
    console.log(`  ✓ general ledger running balances rebuilt: ${rows} row(s)`);

    const after = await subledgerCheck(ds, SPEC.companyId);
    console.log('');
    printCheck('After', after);
    const remainingDrift = await customerBalanceDrift(ds, SPEC.companyId);
    const [customer] = await ds.query(
      `SELECT balance::text FROM customers WHERE id = $1`,
      [SPEC.customerId],
    );
    console.log(
      `    ${SPEC.customerName} balance ....... ${money(customer.balance)}`,
    );
    console.log(`    customers still drifting .... ${remainingDrift.length}`);
    console.log(
      after.difference.abs().lessThan('0.01')
        ? '\nDone: A/R control agrees with the subledger.'
        : '\n! A/R control still differs — review.',
    );
  } catch (err) {
    if (err instanceof PreconditionError) {
      console.error(`\nStopped: ${err.message}`);
      process.exitCode = 2;
      return;
    }
    throw err;
  } finally {
    await app.close();
  }
}

run().catch((err) => {
  const e = err as {
    response?: { code?: string; message?: string };
    message?: string;
  };
  console.error(
    'Correction failed:',
    e.response?.code ?? '',
    e.response?.message ?? e.message ?? err,
  );
  process.exit(1);
});
