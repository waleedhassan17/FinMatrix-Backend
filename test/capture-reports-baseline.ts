/**
 * Reports v2 baseline — the figures the reports upgrade must not move.
 *
 * Captures, for each demo company, the statement totals that Phase 1 promises
 * to keep to the paisa (balance sheet, trial balance, P&L) and the cash-flow
 * figures it is allowed to RE-CLASSIFY but not to change in total. Run once
 * against the unchanged code to write the fixture, then with --compare after
 * every phase: anything that moved is printed, so each change can be
 * explained rather than discovered.
 *
 * Usage: boot the API, then
 *   BASE_URL=http://localhost:3100/api/v1 \
 *   npx ts-node -r tsconfig-paths/register test/capture-reports-baseline.ts [--compare]
 *
 * Reads only. Never point it at production: it is harmless there, but the
 * fixture it writes would describe somebody else's books.
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');

const BASE = process.env.BASE_URL || 'http://localhost:3000/api/v1';
const COMPARE = process.argv.includes('--compare');
const FIXTURE = path.join(__dirname, 'fixtures', 'reports-baseline.json');
const AS_OF = process.env.AS_OF || new Date().toISOString().slice(0, 10);
const FY_START = `${AS_OF.slice(0, 4)}-01-01`;

const COMPANIES = [
  { label: 'MetroMatrix', email: 'metromatrix@gmail.com' },
  { label: 'Warehouse Co', email: 'warehouse@gmail.com' },
];
const PASSWORD = process.env.ADMIN_PASSWORD || '123456';

async function req(path: string, token?: string, cid?: string, json?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cid) headers['x-company-id'] = cid;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  // A 429 is the sign-in throttle, not a broken report: back off and retry,
  // as the acceptance suites do.
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(`${BASE}${path}`, {
      method: json !== undefined ? 'POST' : 'GET',
      headers,
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    if (r.status === 429 && attempt < 6) {
      await new Promise((res) => setTimeout(res, 15000));
      continue;
    }
    const body = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`${path} → ${r.status} ${JSON.stringify(body)}`);
    return body;
  }
}

/** The residual the indirect method could not attribute, or 0. */
const residualOf = (cf: any): number =>
  (cf?.operatingIndirect?.adjustments ?? []).find(
    (a: any) => a.label === 'Other operating adjustments',
  )?.amount ?? 0;

const cashFlowFigures = (cf: any) => ({
  operating: cf.operating.total,
  investing: cf.investing.total,
  financing: cf.financing.total,
  netChange: cf.netChange,
  beginningCash: cf.beginningCash,
  endingCash: cf.endingCash,
  residual: residualOf(cf),
  lines: Object.fromEntries(
    ['operating', 'investing', 'financing'].flatMap((s) =>
      (cf[s].lines ?? []).map((l: any) => [`${s}:${l.label}`, l.amount]),
    ),
  ),
});

async function capture(company: { label: string; email: string }) {
  const login = await req('/auth/signin', undefined, undefined, {
    email: company.email,
    password: PASSWORD,
  });
  const token = login?.data?.tokens?.accessToken;
  const cid = login?.data?.companyId;
  if (!token || !cid) throw new Error(`cannot sign in as ${company.email}`);
  const get = (p: string) => req(p, token, cid);

  const bs = await get(`/reports/balance-sheet?asOfDate=${AS_OF}`);
  const tbAll = await get(
    `/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31`,
  );
  const tbFy = await get(
    `/reports/trial-balance?startDate=${FY_START}&endDate=${AS_OF}`,
  );
  const plAll = await get(
    `/reports/profit-loss?startDate=1970-01-01&endDate=${AS_OF}`,
  );
  const plFy = await get(
    `/reports/profit-loss?startDate=${FY_START}&endDate=${AS_OF}`,
  );
  const cfAll = await get(
    `/reports/cash-flow?startDate=1970-01-01&endDate=${AS_OF}`,
  );
  const cfFy = await get(
    `/reports/cash-flow?startDate=${FY_START}&endDate=${AS_OF}`,
  );

  return {
    balanceSheet: {
      asOfDate: bs.asOfDate,
      totalAssets: bs.totalAssets,
      totalLiabilities: bs.totalLiabilities,
      totalEquity: bs.totalEquity,
      isBalanced: bs.isBalanced,
    },
    trialBalance: {
      allTime: {
        totalDebits: tbAll.totalDebits,
        totalCredits: tbAll.totalCredits,
        isBalanced: tbAll.isBalanced,
      },
      currentFy: {
        totalDebits: tbFy.totalDebits,
        totalCredits: tbFy.totalCredits,
        isBalanced: tbFy.isBalanced,
      },
    },
    profitLoss: {
      allTime: {
        revenue: plAll.revenue,
        expenses: plAll.expenses,
        netIncome: plAll.netIncome,
      },
      currentFy: {
        revenue: plFy.revenue,
        expenses: plFy.expenses,
        netIncome: plFy.netIncome,
      },
    },
    cashFlow: {
      allTime: cashFlowFigures(cfAll),
      currentFy: cashFlowFigures(cfFy),
    },
  };
}

/** Every leaf whose value differs, as `path: before → after`. */
function diff(before: any, after: any, at = ''): string[] {
  if (
    typeof before !== 'object' ||
    before === null ||
    typeof after !== 'object' ||
    after === null
  ) {
    return before === after
      ? []
      : [`${at}: ${JSON.stringify(before)} → ${JSON.stringify(after)}`];
  }
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].flatMap((k) =>
    diff(before[k], after[k], at ? `${at}.${k}` : k),
  );
}

async function main() {
  const figures: Record<string, unknown> = {};
  for (const c of COMPANIES) figures[c.label] = await capture(c);
  const snapshot = {
    capturedAt: AS_OF,
    fiscalYearStart: FY_START,
    companies: figures,
  };

  if (!COMPARE) {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    fs.writeFileSync(FIXTURE, JSON.stringify(snapshot, null, 2) + '\n');
    console.log(`baseline written → ${FIXTURE}`);
    return;
  }

  const before = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const moved = diff(before.companies, snapshot.companies);
  if (!moved.length) {
    console.log('baseline: nothing moved');
    return;
  }
  console.log(`baseline: ${moved.length} figure(s) moved`);
  for (const m of moved) console.log(`  ${m}`);
  process.exitCode = 1;
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
