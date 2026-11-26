/**
 * Migration Center — what the REST of the books make of a migration.
 * ===================================================================
 * The eleven checks prove the migrated balances are right. This proves the
 * reports, statements and undo read them the way an accountant would, for a
 * realistic trial balance: income and expense accounts, sales tax both ways,
 * accounts the chart did not have, open items and stock.
 *
 *   1. Fiscal-year start cutover (year starts July, cutover 1 July 2026):
 *      last year's income is retained earnings, not this year's profit; the
 *      first period's P&L, cash flow and tax return start clean.
 *   2. The cash-flow statement over a period that contains the migration
 *      shows it as an opening position, never as trade, loans or capital.
 *   3. Sales tax brought forward is not "collected" in any period.
 *   4. Customer and vendor statements and the party ledger carry the
 *      migrated open items, attributed to their party and document, and
 *      agree with the control accounts.
 *   5. The analytics dashboard does not count migrated open invoices and
 *      bills as sales and purchases.
 *   6. Migrate → undo → migrate → undo works when the second migration
 *      reactivates accounts the first one added (and the books return to
 *      empty each time).
 *   7. Mid-year cutover (calendar year): the year-to-date P&L still includes
 *      the migrated income, the cutover month does not.
 *   8. An open invoice dated ON the cutover day is refused: that day belongs
 *      to FinMatrix.
 *
 * Runs in-process against DATABASE settings from .env:
 *   npx ts-node -r tsconfig-paths/register test/migration-books.acceptance.ts
 */
import Decimal from 'decimal.js';
import { asUpload, bootHarness, freshCompany } from './migration-harness';
import {
  BooksSpec,
  buildStarterXlsx,
  cleanBooks,
} from './fixtures/migration/workbook-builder';
import { PartyLedgerService } from '../src/modules/ledger/party-ledger.service';
import { PartyHistoryService } from '../src/modules/ledger/party-history.service';
import { PaymentsService } from '../src/modules/payments/payments.service';
import { TaxService } from '../src/modules/tax/tax.service';
import { businessToday } from '../src/common/utils/business-date.util';

let pass = 0;
let fail = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(name);
    console.log(
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 700) : ''}`,
    );
  }
};
const eq = (a: unknown, b: unknown) =>
  new Decimal(String(a ?? 0)).equals(new Decimal(String(b ?? 0)));

/**
 * A distributor's books at the close of 30 June 2026, the last day of its
 * fiscal year. Net income for the year: 900,000 − 500,000 − 120,000 = 280,000.
 */
function booksWithIncome(cutoverDate: string): BooksSpec {
  const base = cleanBooks();
  return {
    ...base,
    cutoverDate,
    trialBalance: [
      { number: '1000', name: 'Cash', debit: '1,50,000' },
      { number: '1010', name: 'Business Checking', debit: '4,20,500.50' },
      { number: '1100', name: 'Accounts Receivable', debit: '245000' },
      { number: '1200', name: 'Inventory', debit: '1,82,000' },
      { number: '1300', name: 'Sales Tax Recoverable', debit: '15,000' },
      { number: '1500', name: 'Furniture & Fixtures', debit: '95,000' },
      { number: '2000', name: 'Accounts Payable', credit: '1,63,250' },
      { number: '2100', name: 'Short-term Loan', credit: '2,00,000' },
      { number: '2300', name: 'Sales Tax Payable', credit: '40,000' },
      { number: '3000', name: 'Owner Equity', credit: '3,00,000' },
      { number: '3100', name: 'Retained Earnings', credit: '1,24,250.50' },
      { number: '4000', name: 'Sales', credit: '9,00,000' },
      { number: '5000', name: 'Cost of Goods Sold', debit: '5,00,000' },
      // FinMatrix's own 6000 is Rent Expense: the same number AND meaning, so
      // it merges (account-clash rule). A different name would — rightly —
      // ask the owner what the account is.
      { number: '6000', name: 'Rent Expense', debit: '1,20,000' },
    ],
  };
}

const CASH_TOTAL = '570500.50';
const PRIOR_INCOME = '280000';
const RE_POSTED = '124250.50';

async function main() {
  const h = await bootHarness();
  const ledger = h.app.get(PartyLedgerService);
  const history = h.app.get(PartyHistoryService);
  const payments = h.app.get(PaymentsService);
  const tax = h.app.get(TaxService);
  const today = businessToday();

  const migrate = async (
    label: string,
    spec: BooksSpec,
    fyStartMonth: number,
    existing?: { companyId: string; user: any },
  ) => {
    const co = existing ?? (await freshCompany(h.ds, `${label}-${Date.now()}`));
    await h.ds.query(
      `UPDATE companies SET fiscal_year_start_month = $2 WHERE id = $1`,
      [co.companyId, fyStartMonth],
    );
    const xlsx = await buildStarterXlsx(spec, {});
    const batch = await h.svc.create(co.companyId, co.user, {
      sourceSystem: 'finmatrix_template',
      cutoverDate: spec.cutoverDate,
    });
    const analysed = await h.svc.addFiles(co.companyId, co.user, batch.id, [
      asUpload(xlsx, `${label}.xlsx`),
    ]);
    if (analysed.issues.blocking > 0) {
      const issues = await h.svc.listIssues(co.companyId, batch.id, {
        limit: 10,
      });
      return {
        ...co,
        batchId: batch.id,
        committed: false,
        blocking: issues.items.map((x: any) => `${x.code}: ${x.message}`),
      };
    }
    const v = await h.svc.validate(co.companyId, co.user, batch.id);
    const failed = (v.checks ?? []).filter((c: any) => !c.passed);
    if (failed.length || v.status !== 'ready')
      throw new Error(
        `${label}: not ready (${v.status}) ${failed.map((c: any) => `${c.code} ${JSON.stringify(c.details).slice(0, 300)}`).join(' | ')}`,
      );
    await h.svc.signOff(co.companyId, co.user, batch.id, {
      confirmed: true,
      spotCheckDone: true,
    });
    await h.svc.commit(co.companyId, co.user, batch.id);
    return { ...co, batchId: batch.id, committed: true, blocking: [] };
  };

  try {
    // ── 1. Fiscal-year start cutover ─────────────────────────────────
    console.log('\n── 1. Year starts in July; cutover 1 July 2026');
    const spec = booksWithIncome('2026-07-01');
    const A = await migrate('fy-start', spec, 7);
    ok('migration committed', A.committed, A.blocking);
    const { companyId } = A;

    const [entryDates] = await h.ds.query(
      `SELECT array_agg(DISTINCT date::text) AS d FROM general_ledger WHERE company_id = $1 AND source_type = 'migration'`,
      [companyId],
    );
    ok(
      'opening entries are dated the close of the day before cutover (2026-06-30)',
      JSON.stringify(entryDates.d) === JSON.stringify(['2026-06-30']),
      entryDates.d,
    );
    const [mv] = await h.ds.query(
      `SELECT array_agg(DISTINCT date::text) AS d FROM inventory_movements WHERE company_id = $1 AND source_type = 'migration'`,
      [companyId],
    );
    ok(
      'opening stock movements carry the same date as their entry',
      JSON.stringify(mv.d) === JSON.stringify(['2026-06-30']),
      mv.d,
    );
    const [lock] = await h.ds.query(
      `SELECT books_locked_until::text AS l FROM companies WHERE id = $1`,
      [companyId],
    );
    ok('books are closed through 2026-06-30', lock.l === '2026-06-30', lock);

    const register = await h.reports.accountRegister(
      companyId,
      '1100',
      '1970-01-01',
      '2999-12-31',
    );
    ok(
      'the receivables register names each migrated invoice and its customer',
      register.entries.length === 4 &&
        register.entries.every(
          (e: any) =>
            /^INV-100\d$/.test(e.documentNumber) && !!e.counterpartyName,
        ),
      register.entries.map((e: any) => [e.documentNumber, e.counterpartyName]),
    );

    // The audit trail is written after commit, on its own connection.
    let audited = 0;
    for (let t = 0; t < 50 && audited < 4; t++) {
      const [a] = await h.ds.query(
        `SELECT COUNT(*)::int AS n FROM audit_trail t
           JOIN invoices i ON i.id = t.resource_id
          WHERE i.company_id = $1 AND i.source = 'migration'
            AND t.resource_type = 'invoice' AND t.action = 'create'`,
        [companyId],
      );
      audited = a.n;
      if (audited < 4) await new Promise((r) => setTimeout(r, 100));
    }
    ok(
      'each migrated invoice has its create in the audit trail',
      audited === 4,
      {
        audited,
      },
    );

    const pnlNew = await h.reports.profitLoss(
      companyId,
      '2026-07-01',
      '2027-06-30',
    );
    ok(
      "FY 2026 (from cutover) P&L is empty: last year's income is not this year's",
      pnlNew.revenue === 0 && pnlNew.netIncome === 0,
      { revenue: pnlNew.revenue, netIncome: pnlNew.netIncome },
    );
    const pnlOld = await h.reports.profitLoss(
      companyId,
      '2025-07-01',
      '2026-06-30',
    );
    ok(
      'FY 2025 P&L carries the migrated year: revenue 900,000, net income 280,000',
      eq(pnlOld.revenue, 900000) && eq(pnlOld.netIncome, PRIOR_INCOME),
      { revenue: pnlOld.revenue, netIncome: pnlOld.netIncome },
    );
    const bs = await h.reports.balanceSheet(companyId, '2026-07-01');
    const cy = bs.equity.find(
      (l: any) => l.synthetic === 'currentYearEarnings',
    );
    const re = bs.equity.find((l: any) => l.accountCode === '3100');
    ok(
      'balance sheet at cutover: no current-year earnings',
      !cy || cy.amount === 0,
      cy,
    );
    ok(
      'balance sheet at cutover: Retained Earnings = 124,250.50 posted + 280,000 earned',
      !!re &&
        eq(re.amount, new Decimal(RE_POSTED).plus(PRIOR_INCOME)) &&
        eq(re.composite?.priorYearsEarnings, PRIOR_INCOME),
      re,
    );
    ok('balance sheet balances', bs.isBalanced, {
      a: bs.totalAssets,
      le: bs.totalLiabilitiesAndEquity,
    });

    // ── 2. Cash flow ────────────────────────────────────────────────
    console.log('\n── 2. Cash flow');
    const cfNew = await h.reports.cashFlow(companyId, '2026-07-01', today);
    ok(
      'from cutover: beginning cash is the migrated cash and nothing moved',
      eq(cfNew.beginningCash, CASH_TOTAL) &&
        cfNew.netChange === 0 &&
        cfNew.operating.total === 0 &&
        cfNew.financing.total === 0 &&
        cfNew.investing.total === 0,
      {
        beginning: cfNew.beginningCash,
        net: cfNew.netChange,
        op: cfNew.operating,
        fin: cfNew.financing,
      },
    );
    const cfSpan = await h.reports.cashFlow(companyId, '2026-01-01', today);
    const finLines = cfSpan.financing.lines.filter((l: any) => l.amount !== 0);
    ok(
      'over a period containing the migration it is one opening-balance line',
      cfSpan.operating.total === 0 &&
        cfSpan.investing.total === 0 &&
        finLines.length === 1 &&
        finLines[0].lineKey === 'fin.opening_balance' &&
        eq(finLines[0].amount, CASH_TOTAL),
      {
        op: cfSpan.operating,
        inv: cfSpan.investing,
        fin: cfSpan.financing,
      },
    );
    ok(
      'its indirect method agrees (operating 0)',
      (cfSpan.operatingIndirect?.total ?? 0) === 0,
      cfSpan.operatingIndirect,
    );

    // ── 3. Tax ──────────────────────────────────────────────────────
    console.log('\n── 3. Sales tax brought forward');
    const taxNew = await tax.getLiability(companyId, '2026-07-01', today);
    ok(
      'a return from cutover shows no tax collected or recoverable',
      taxNew.totalCollected === 0 &&
        taxNew.inputTaxRecoverable === 0 &&
        taxNew.totalNet === 0,
      taxNew,
    );
    const taxAll = await tax.getLiability(companyId);
    ok(
      'all-time: nothing "collected"; 25,000 owed, shown as brought forward',
      taxAll.totalCollected === 0 &&
        taxAll.totalNet === 25000 &&
        taxAll.rows.some(
          (r: any) => r.taxRateId === 'brought-forward' && r.net === 25000,
        ),
      taxAll,
    );

    // ── 4. Party ledger and statements ──────────────────────────────
    console.log('\n── 4. Customer and vendor statements');
    const alNoor = (
      await h.ds.query(
        `SELECT id FROM customers WHERE company_id = $1 AND code = 'C-0001'`,
        [companyId],
      )
    )[0].id;
    const st = await ledger.statement(
      companyId,
      'customer',
      alNoor,
      '2026-07-01',
      today,
    );
    ok(
      "Al-Noor's statement from cutover opens at 165,000 (INV-1001 + INV-1002)",
      st.openingBalance === 165000 && st.closingBalance === 165000,
      { opening: st.openingBalance, closing: st.closingBalance },
    );
    const stSpan = await ledger.statement(
      companyId,
      'customer',
      alNoor,
      '2026-06-01',
      today,
    );
    ok(
      'over the opening day it lists each brought-forward invoice by number',
      stSpan.openingBalance === 0 &&
        stSpan.closingBalance === 165000 &&
        stSpan.lines.length === 2 &&
        stSpan.lines.every((l: any) => /^INV-100[12]$/.test(l.reference)),
      stSpan.lines,
    );
    const custParties = await ledger.parties(companyId, 'customer');
    const custTotal = custParties.parties.reduce(
      (t: number, p: any) => t + p.closing,
      0,
    );
    ok(
      'customers in the party ledger add up to receivables (245,000)',
      Math.round(custTotal * 100) === 24500000,
      custParties.parties.map((p: any) => [p.partyCode, p.closing]),
    );
    const vendParties = await ledger.parties(companyId, 'vendor');
    const vendTotal = vendParties.parties.reduce(
      (t: number, p: any) => t + p.closing,
      0,
    );
    ok(
      'vendors in the party ledger add up to payables (163,250 owed)',
      Math.round(vendTotal * 100) === -16325000,
      vendParties.parties.map((p: any) => [p.partyCode, p.closing]),
    );
    const hist = await history.history(
      companyId,
      'customer',
      alNoor,
      { role: 'admin' },
      2025,
    );
    ok(
      "Al-Noor's FY 2025 history closes at what it owes (165,000)",
      hist.closingBalance === 165000,
      { closing: hist.closingBalance, totals: (hist as any).totals },
    );

    // ── 5. Dashboard ────────────────────────────────────────────────
    console.log('\n── 5. Analytics dashboard');
    const dash = await h.reports.analyticsDashboard(companyId);
    const revenueShown = (dash.revenueTrend ?? []).reduce(
      (t: number, r: any) => t + r.value,
      0,
    );
    ok(
      'migrated open invoices are not counted as sales in the revenue trend',
      revenueShown === 0 && (dash.topCustomers ?? []).length === 0,
      { revenueTrend: dash.revenueTrend, top: dash.topCustomers },
    );

    // ── 6. Undo, migrate again, undo again ──────────────────────────
    console.log('\n── 6. Migrate → undo → migrate → undo');
    await h.svc.rollback(companyId, A.user, A.batchId);
    const empty1 = await h.reports.trialBalance(
      companyId,
      '1970-01-01',
      '2999-12-31',
    );
    ok('first undo empties the trial balance', empty1.rows.length === 0, {
      rows: empty1.rows.length,
    });
    const [plDates] = await h.ds.query(
      `SELECT array_agg(DISTINCT date::text) AS d FROM general_ledger WHERE company_id = $1 AND source_type = 'migration_rollback'`,
      [companyId],
    );
    ok(
      'undo reverses each entry on its own date',
      JSON.stringify(plDates.d) === JSON.stringify(['2026-06-30']),
      plDates.d,
    );
    const unbalanced = await h.ds.query(
      `SELECT source_id, account_id, SUM(debit - credit)::text AS net
         FROM general_ledger
        WHERE company_id = $1 AND source_type IN ('migration', 'migration_rollback')
        GROUP BY source_id, account_id
       HAVING SUM(debit - credit) <> 0`,
      [companyId],
    );
    const [named] = await h.ds.query(
      `SELECT COUNT(*)::int AS n FROM general_ledger
        WHERE company_id = $1 AND source_type = 'migration_rollback' AND source_id <> $2`,
      [companyId, A.batchId],
    );
    ok(
      'every undo row reverses the same document on the same account (each nets to 0)',
      unbalanced.length === 0 && named.n === 7, // 4 invoices + 3 bills
      { unbalanced, namedReversals: named.n },
    );
    const pnlAfterUndo = await h.reports.profitLoss(
      companyId,
      '2025-07-01',
      '2026-06-30',
    );
    ok(
      'after undo no period holds anything',
      pnlAfterUndo.revenue === 0 && pnlAfterUndo.netIncome === 0,
      pnlAfterUndo.netIncome,
    );
    const B = await migrate('again', spec, 7, A);
    ok(
      'second migration committed (reactivates 1500 and 2100)',
      B.committed,
      B.blocking,
    );
    let secondUndo: unknown = null;
    try {
      await h.svc.rollback(companyId, A.user, B.batchId);
    } catch (err: any) {
      secondUndo = err?.response ?? err?.message;
    }
    ok(
      'the second migration can be undone too',
      secondUndo === null,
      secondUndo,
    );
    const empty2 = await h.reports.trialBalance(
      companyId,
      '1970-01-01',
      '2999-12-31',
    );
    ok('second undo empties the trial balance', empty2.rows.length === 0, {
      rows: empty2.rows.length,
    });

    // Third time, then trade on it: a receipt against a migrated invoice.
    const C = await migrate('third', spec, 7, A);
    ok('third migration committed', C.committed, C.blocking);
    const inv1001 = (
      await h.ds.query(
        `SELECT id, customer_id FROM invoices WHERE company_id = $1 AND legacy_ref = 'INV-1001' AND migration_batch_id = $2`,
        [companyId, C.batchId],
      )
    )[0];
    await payments.receive(companyId, A.user.id, {
      customerId: inv1001.customer_id,
      paymentDate: today,
      amount: '50000',
      paymentMethod: 'cash',
      applications: [{ invoiceId: inv1001.id, amount: '50000' }],
    } as any);
    const st2 = await ledger.statement(
      companyId,
      'customer',
      inv1001.customer_id,
      '2026-07-01',
      today,
    );
    ok(
      'after a 50,000 receipt the statement runs 165,000 → 115,000',
      st2.openingBalance === 165000 && st2.closingBalance === 115000,
      {
        opening: st2.openingBalance,
        closing: st2.closingBalance,
        lines: st2.lines,
      },
    );
    const [cb] = await h.ds.query(
      `SELECT balance::text AS b FROM customers WHERE id = $1`,
      [inv1001.customer_id],
    );
    ok(
      "the statement agrees with the customer's balance column",
      eq(cb.b, st2.closingBalance),
      cb,
    );

    // ── 7. Mid-year cutover ─────────────────────────────────────────
    console.log('\n── 7. Calendar year; cutover 1 July 2026 (mid-year)');
    const M = await migrate('mid-year', booksWithIncome('2026-07-01'), 1);
    ok('migration committed', M.committed, M.blocking);
    const pnlJuly = await h.reports.profitLoss(
      M.companyId,
      '2026-07-01',
      '2026-07-31',
    );
    ok(
      'July 2026 (the cutover month) shows no migrated income',
      pnlJuly.revenue === 0 && pnlJuly.netIncome === 0,
      pnlJuly.netIncome,
    );
    const pnlYtd = await h.reports.profitLoss(
      M.companyId,
      '2026-01-01',
      '2026-12-31',
    );
    ok(
      'calendar 2026 year to date includes the migrated 280,000',
      eq(pnlYtd.netIncome, PRIOR_INCOME),
      pnlYtd.netIncome,
    );
    const bsMid = await h.reports.balanceSheet(M.companyId, '2026-07-01');
    const cyMid = bsMid.equity.find(
      (l: any) => l.synthetic === 'currentYearEarnings',
    );
    ok(
      'balance sheet at cutover: 280,000 is current-year earnings',
      !!cyMid && eq(cyMid.amount, PRIOR_INCOME),
      cyMid,
    );

    // ── 8. Open item dated on the cutover day ───────────────────────
    console.log('\n── 8. An open invoice dated on the cutover day');
    const onDay = booksWithIncome('2026-07-01');
    onDay.openInvoices = onDay.openInvoices.map((o, i) =>
      i === 0 ? { ...o, date: '01/07/2026', due: '31/07/2026' } : o,
    );
    const D = await migrate('on-day', onDay, 7);
    ok(
      'refused: it belongs to FinMatrix, not the opening balances',
      !D.committed && D.blocking.some((m: string) => /INVALID_DATE/.test(m)),
      D.blocking,
    );
  } finally {
    await h.close();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('Failed:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
