/**
 * Reports v2 — identity sweep over EVERY company in a database. Read-only.
 *
 * Calls ReportsService directly (no HTTP, no logins), so it can check books it
 * has no password for — the point is to run it against a copy of real data
 * and see every company's statements tie, not just the demo ones.
 *
 * For each company it asserts:
 *   BS     A = L + E (raw verdict), gap 0, sections foot to the totals, no
 *          equity account code repeated, Retained Earnings breakdown = BS line
 *   TB     movement (all time), closing (today) and working (FY to date)
 *          all balance, every column pair
 *   CF     sections sum to netChange; endingCash = Cash+Bank on the BS; the
 *          indirect residual (reported, with what was excluded, if non-zero);
 *          every line's drill-down sums to the line
 *   REG    the main cash account's register: opening + Σ rows = closing
 * and logs how long each call took.
 *
 * Usage (point DATABASE_URL at the copy — this boots the whole app):
 *   DATABASE_URL=postgres://... npx ts-node -r tsconfig-paths/register test/reports-v2-sweep.ts
 * Optional: COMPANY_LIMIT=10, AS_OF=2026-10-26.
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { ReportsService } from '../src/modules/reports/reports.service';

/** Optional: the KPI checks run once the insight endpoints exist. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const kpiModule = (() => {
  try {
    return require('../src/modules/reports/reports-kpi.service');
  } catch {
    return null;
  }
})();

const AS_OF = process.env.AS_OF || new Date().toISOString().slice(0, 10);
const LIMIT = parseInt(process.env.COMPANY_LIMIT || '1000', 10);
const near = (a: number, b: number, tol = 0.011) => Math.abs(a - b) <= tol;

let pass = 0;
let fail = 0;
const failures: string[] = [];
const timings: Record<string, number[]> = {};

function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) pass++;
  else {
    fail++;
    failures.push(
      `${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`,
    );
  }
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  const out = await fn();
  (timings[label] ??= []).push(Date.now() - t0);
  return out;
}

async function main() {
  const url = process.env.DATABASE_URL ?? '';
  if (!url) throw new Error('Set DATABASE_URL to the database to sweep.');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const ds = app.get(DataSource);
  const svc = app.get(ReportsService);
  const kpi: any = kpiModule
    ? app.get(kpiModule.ReportsKpiService, { strict: false })
    : null;

  const companies: Array<{ id: string; name: string }> = await ds.query(
    `SELECT c.id, c.name FROM companies c
      WHERE EXISTS (SELECT 1 FROM general_ledger g WHERE g.company_id = c.id)
      ORDER BY c.name LIMIT $1`,
    [LIMIT],
  );
  console.log(
    `\nReports v2 sweep — ${companies.length} companies with postings, as of ${AS_OF}\n`,
  );

  for (const c of companies) {
    const tag = c.name;
    const fyStart = `${(await svc.fiscalYearStartMonth(c.id)) === 1 ? AS_OF.slice(0, 4) + '-01-01' : ''}`;
    const fy = fyStart || AS_OF.slice(0, 4) + '-01-01';

    // ── Balance sheet ──
    const bs = await timed('balanceSheet', () => svc.balanceSheet(c.id, AS_OF));
    ok(`${tag}: BS balanced`, bs.isBalanced && bs.gap === 0, { gap: bs.gap });
    const assetSections = bs.sections.filter((s) =>
      [
        'cashAndBank',
        'receivables',
        'inventory',
        'otherCurrentAssets',
        'fixedAssets',
      ].includes(s.key),
    );
    ok(
      `${tag}: BS asset sections foot`,
      near(
        assetSections.reduce((t, s) => t + s.subtotal, 0),
        bs.totalAssets,
        0.05,
      ),
    );
    const codes = bs.equity.map((l) => l.accountCode).filter(Boolean);
    ok(
      `${tag}: BS no repeated equity code`,
      new Set(codes).size === codes.length,
      codes,
    );
    const re = await timed('retainedEarnings', () =>
      svc.retainedEarnings(c.id, AS_OF),
    );
    const reLine = bs.equity.find(
      (l) => l.composite || l.synthetic === 'retainedEarnings',
    );
    ok(
      `${tag}: RE breakdown = BS line`,
      (reLine?.amount ?? 0) === re.total ||
        (!reLine && near(re.total, 0, 0.0001)),
      {
        line: reLine?.amount,
        total: re.total,
      },
    );

    // ── Trial balance ──
    for (const [mode, s, e] of [
      ['movement', '1970-01-01', '2999-12-31'],
      ['closing', '1970-01-01', AS_OF],
      ['working', fy, AS_OF],
    ] as const) {
      const tb: any = await timed(`trialBalance:${mode}`, () =>
        svc.trialBalance(c.id, s, e, mode),
      );
      ok(
        `${tag}: TB ${mode} balanced`,
        tb.isBalanced === true,
        tb.balanced ?? { dr: tb.totalDebits, cr: tb.totalCredits },
      );
    }

    // ── Cash flow ──
    for (const [label, s] of [
      ['FY', fy],
      ['all-time', '1970-01-01'],
    ] as const) {
      const cf = await timed('cashFlow', () => svc.cashFlow(c.id, s, AS_OF));
      ok(
        `${tag}: CF ${label} sections = netChange`,
        near(
          cf.operating.total + cf.investing.total + cf.financing.total,
          cf.netChange,
          0.02,
        ),
      );
      ok(
        `${tag}: CF ${label} ties to BS cash`,
        cf.cashTie?.ties === true,
        cf.cashTie,
      );
      const residual = cf.operatingIndirect?.adjustments.find(
        (a) => a.label === 'Other operating adjustments',
      );
      ok(`${tag}: CF ${label} residual 0`, !residual, {
        residual: residual?.amount,
        excluded: cf.operatingIndirect?.excludedNonCash,
      });
      if (label === 'FY') {
        for (const line of [
          ...cf.operating.lines,
          ...cf.investing.lines,
          ...cf.financing.lines,
        ]) {
          let page = 1;
          let sum = 0;
          let lineAmount = 0;
          for (;;) {
            const r = await timed('cashFlowLineEntries', () =>
              svc.cashFlowLineEntries(c.id, line.lineKey!, s, AS_OF, page, 200),
            );
            lineAmount = r.lineAmount;
            sum += r.entries.reduce((t, x) => t + x.allocatedAmount, 0);
            if (page * 200 >= r.total) break;
            page++;
          }
          ok(
            `${tag}: CF line ${line.lineKey} drill sums`,
            near(lineAmount, line.amount, 0.001) &&
              near(sum, line.amount, 0.01 * Math.max(1, page * 2)),
            {
              line: line.amount,
              drill: Math.round(sum * 100) / 100,
            },
          );
        }
      }
    }

    // ── Register of the first cash account ──
    const cash = await ds.query(
      `SELECT a.account_number AS code FROM accounts a
        WHERE a.company_id = $1 AND a.sub_type IN ('Cash','Bank') ORDER BY a.account_number LIMIT 1`,
      [c.id],
    );
    if (cash[0]) {
      let page = 1;
      let reg: any;
      let sum = 0;
      for (;;) {
        reg = await timed('accountRegister', () =>
          svc.accountRegister(c.id, cash[0].code, fy, AS_OF, page, 200),
        );
        sum += reg.entries.reduce((t: number, x: any) => t + x.amount, 0);
        if (page * 200 >= reg.total) break;
        page++;
      }
      ok(
        `${tag}: register opening + Σ = closing`,
        near(
          reg.openingBalance + sum,
          reg.closingBalance,
          0.01 * Math.max(1, reg.total / 50),
        ),
        {
          opening: reg.openingBalance,
          sum,
          closing: reg.closingBalance,
        },
      );
    }

    // ── KPIs (Phase 3) ──
    if (kpi) {
      const h: any = await timed('financialHealth', () =>
        kpi.financialHealth(c.id, AS_OF),
      );
      ok(
        `${tag}: KPIs finite or null`,
        h.kpis.every((k: any) => k.value === null || Number.isFinite(k.value)),
      );
      const a: any = await timed('analytics', () =>
        kpi.analytics(c.id, fy, AS_OF),
      );
      const pl = await svc.profitLoss(c.id, fy, AS_OF);
      const sumOf = (k: string) =>
        a.series.reduce((t: number, p: any) => t + p[k], 0);
      ok(
        `${tag}: analytics Σ revenue = P&L`,
        near(sumOf('revenue'), pl.revenue, 0.001),
        { series: sumOf('revenue'), pl: pl.revenue },
      );
      ok(
        `${tag}: analytics Σ netIncome = P&L`,
        near(sumOf('netIncome'), pl.netIncome, 0.001),
        { series: sumOf('netIncome'), pl: pl.netIncome },
      );
      const inv: any = await timed('inventoryHealth', () =>
        kpi.inventoryHealth(c.id, AS_OF),
      );
      ok(
        `${tag}: inventory-health ≤ valuation`,
        inv.totals.stockValue <= inv.totals.valuationTotal + 0.01,
        inv.totals,
      );
    }
  }

  console.log('Timings (ms) — max / median per call:');
  for (const [k, v] of Object.entries(timings)) {
    const sorted = [...v].sort((a, b) => a - b);
    console.log(
      `  ${k.padEnd(28)} max ${String(sorted[sorted.length - 1]).padStart(5)}   median ${sorted[Math.floor(sorted.length / 2)]}   (${v.length} calls)`,
    );
  }
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  await app.close();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
