/**
 * Migration Center — property test over generated ledgers.
 * ==========================================================
 * Generates N random but VALID small companies (balanced trial balance; open
 * invoices that sum to receivables, open bills to payables, stock to
 * inventory; amounts in lakh, international and "Rs" formats), writes each
 * as a starter workbook, migrates it into a fresh company and asserts:
 *
 *   • analysis raises no blocking issue and readiness reaches 100%
 *   • all nine checks pass at zero difference
 *   • after commit: the trial balance balances, Assets = Liabilities +
 *     Equity, Migration Clearing is exactly 0, and the period lock is the day
 *     before the cutover
 *   • every fifth company is rolled back, and its trial balance is empty again
 *
 * A failure prints its seed; `SEED=<n> N=1` replays exactly that company.
 *
 *   N=200 npm run test:migration-property          (CI)
 *   N=5000 npm run test:migration-property         (once, locally)
 *
 * Runs in-process (test/migration-harness.ts) against DATABASE settings from
 * .env — no API needed, and no sign-ups through the throttled auth routes.
 */
import Decimal from 'decimal.js';
import { asUpload, bootHarness, freshCompany } from './migration-harness';
import {
  buildStarterXlsx,
  randomBooks,
} from './fixtures/migration/workbook-builder';

const N = Number(process.env.N ?? 200);
const SEED0 = Number(process.env.SEED ?? 1);

async function main() {
  const h = await bootHarness();
  const failures: Array<{ seed: number; reason: string }> = [];
  const started = Date.now();
  let committed = 0;
  let rolledBack = 0;
  try {
    for (let i = 0; i < N; i++) {
      const seed = SEED0 + i;
      try {
        const spec = randomBooks(seed);
        const xlsx = await buildStarterXlsx(spec, {
          keepInstructionRows: seed % 2 === 0,
        });
        const { companyId, user } = await freshCompany(
          h.ds,
          `prop-${seed}-${Date.now()}`,
        );
        const batch = await h.svc.create(companyId, user, {
          sourceSystem: 'finmatrix_template',
          cutoverDate: spec.cutoverDate,
        });
        const analysed = await h.svc.addFiles(companyId, user, batch.id, [
          asUpload(xlsx, `books-${seed}.xlsx`),
        ]);
        if (analysed.issues.blocking > 0) {
          const issues = await h.svc.listIssues(companyId, batch.id, {
            limit: 5,
          });
          throw new Error(
            `blocking issues after analysis: ${issues.items.map((x) => `${x.code} ${x.message}`).join(' | ')}`,
          );
        }
        const v = await h.svc.validate(companyId, user, batch.id);
        const failed = (v.checks ?? []).filter((c) => !c.passed);
        if (failed.length)
          throw new Error(
            `checks failed: ${failed.map((c) => `${c.code} diff ${c.difference} ${JSON.stringify(c.details).slice(0, 300)}`).join(' | ')}`,
          );
        if (v.status !== 'ready' || v.readiness !== 100)
          throw new Error(`not ready: ${v.status} ${v.readiness}%`);
        await h.svc.signOff(companyId, user, batch.id, {
          confirmed: true,
          spotCheckDone: true,
        });
        await h.svc.commit(companyId, user, batch.id);
        committed += 1;

        const tb = await h.reports.trialBalance(
          companyId,
          '1970-01-01',
          '2999-12-31',
        );
        if (!tb.isBalanced)
          throw new Error(
            `trial balance does not balance: ${tb.totalDebits} vs ${tb.totalCredits}`,
          );
        const bs = await h.reports.balanceSheet(companyId, spec.cutoverDate);
        if (!bs.isBalanced)
          throw new Error(
            `A ≠ L + E: ${bs.totalAssets} vs ${bs.totalLiabilitiesAndEquity}`,
          );
        const [clr] = await h.ds.query(
          `SELECT balance::text AS b FROM accounts WHERE company_id = $1 AND account_number = '3950'`,
          [companyId],
        );
        if (!new Decimal(clr.b).isZero())
          throw new Error(`Migration Clearing is ${clr.b}`);
        const [lock] = await h.ds.query(
          `SELECT books_locked_until::text AS l FROM companies WHERE id = $1`,
          [companyId],
        );
        if (lock.l !== '2026-06-29')
          throw new Error(`period lock is ${lock.l}`);

        if (seed % 5 === 0) {
          await h.svc.rollback(companyId, user, batch.id);
          rolledBack += 1;
          const after = await h.reports.trialBalance(
            companyId,
            '1970-01-01',
            '2999-12-31',
          );
          if (after.rows.length !== 0)
            throw new Error(
              `rollback left ${after.rows.length} trial balance rows`,
            );
        }
      } catch (err) {
        failures.push({ seed, reason: (err as Error).message.slice(0, 1200) });
        console.log(
          `  ✗ seed ${seed}: ${(err as Error).message.slice(0, 400)}`,
        );
      }
      if ((i + 1) % 25 === 0)
        console.log(
          `  … ${i + 1}/${N} (${failures.length} failed, ${((Date.now() - started) / 1000).toFixed(0)} s)`,
        );
    }
  } finally {
    await h.close();
  }
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\n${N - failures.length}/${N} generated companies migrated and reconciled (${committed} committed, ${rolledBack} rolled back) in ${secs} s`,
  );
  if (failures.length) {
    console.log(
      'Failing seeds (replay with SEED=<n> N=1):\n' +
        failures.map((f) => `  ${f.seed}: ${f.reason}`).join('\n'),
    );
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
