/**
 * Reports v2 — every new endpoint over HTTP: status, shape through the
 * response envelope, and time. Read-only.
 *
 * A service-level test never runs ResponseEnvelopeInterceptor, which is how
 * the P&L drill-down once shipped with its metadata stripped; this goes
 * through it. Each call must answer 200 within BUDGET_MS (default 500).
 *
 * Usage: boot the API, then
 *   BASE_URL=http://localhost:3100/api/v1 \
 *   npx ts-node -r tsconfig-paths/register test/reports-v2-timing.ts
 */
export {};

const BASE = process.env.BASE_URL || 'http://localhost:3000/api/v1';
const BUDGET_MS = parseInt(process.env.BUDGET_MS || '500', 10);
const PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const USERS = (
  process.env.REPORT_USERS || 'warehouse@gmail.com,metromatrix@gmail.com'
).split(',');
const TODAY = new Date().toISOString().slice(0, 10);
const FY = `${TODAY.slice(0, 4)}-01-01`;

let pass = 0;
let fail = 0;
const failures: string[] = [];
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) pass++;
  else {
    fail++;
    failures.push(
      `${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 300) : ''}`,
    );
  }
};

async function call(
  path: string,
  token?: string,
  cid?: string,
  json?: unknown,
) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cid) headers['x-company-id'] = cid;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const r = await fetch(`${BASE}${path}`, {
      method: json !== undefined ? 'POST' : 'GET',
      headers,
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const ms = Date.now() - t0;
    if (r.status === 429 && attempt < 6) {
      await new Promise((res) => setTimeout(res, 15000));
      continue;
    }
    const text = await r.text();
    let body: any = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* CSV */
    }
    return { status: r.status, body, ms };
  }
}

async function main() {
  console.log(
    `\n=== Reports v2 over HTTP @ ${BASE} (budget ${BUDGET_MS} ms) ===\n`,
  );
  for (const email of USERS) {
    const login = await call('/auth/signin', undefined, undefined, {
      email,
      password: PASSWORD,
    });
    const token = login.body?.data?.tokens?.accessToken;
    const cid = login.body?.data?.companyId;
    ok(`${email}: signs in`, !!token, login.status);
    if (!token) continue;
    const get = (p: string) => call(p, token, cid);

    const routes: Array<[string, string, (d: any) => boolean]> = [
      [
        'register',
        `/reports/accounts/1000/register?startDate=${FY}&endDate=${TODAY}&limit=50`,
        (d) =>
          Array.isArray(d.entries) && 'openingBalance' in d && 'periodNet' in d,
      ],
      [
        'movement',
        `/reports/accounts/4000/movement?startDate=${FY}&endDate=${TODAY}`,
        (d) => Array.isArray(d.byCounterparty) && 'change' in d,
      ],
      [
        'retained-earnings',
        `/reports/balance-sheet/retained-earnings?asOfDate=${TODAY}`,
        (d) => Array.isArray(d.byFiscalYear) && 'total' in d,
      ],
      [
        'cash-flow line',
        `/reports/cash-flow/lines/op.customers/entries?startDate=${FY}&endDate=${TODAY}`,
        (d) => Array.isArray(d.entries) && 'lineAmount' in d,
      ],
      [
        'financial-health',
        `/reports/financial-health?asOfDate=${TODAY}`,
        (d) =>
          Array.isArray(d.kpis) &&
          d.kpis.every((k: any) => 'formula' in k && 'status' in k),
      ],
      [
        'analytics',
        `/reports/analytics?startDate=${FY}&endDate=${TODAY}`,
        (d) => Array.isArray(d.series) && Array.isArray(d.kpis) && !!d.health,
      ],
      [
        'inventory-health',
        `/reports/inventory-health?asOfDate=${TODAY}`,
        (d) => Array.isArray(d.belowReorder) && !!d.aging && !!d.totals,
      ],
    ];
    for (const [name, path, shaped] of routes) {
      const r = await get(path);
      const d = r.body?.data;
      ok(`${email}: ${name} 200`, r.status === 200, r.body);
      ok(
        `${email}: ${name} survives the envelope`,
        r.body?.success === true && !!d && shaped(d),
        Object.keys(d ?? {}),
      );
      ok(`${email}: ${name} within budget`, r.ms <= BUDGET_MS, `${r.ms} ms`);
      console.log(
        `  ${email.padEnd(24)} ${name.padEnd(18)} ${String(r.ms).padStart(4)} ms`,
      );
    }

    // The @Res() statements with v2 fields: JSON gains them, CSV does not.
    const raw: Array<[string, string, string[]]> = [
      [
        'balance-sheet',
        `/reports/balance-sheet?asOfDate=${TODAY}&compareTo=${FY}`,
        ['sections', 'subtotals', 'gap', 'comparison'],
      ],
      [
        'trial-balance closing',
        `/reports/trial-balance?mode=closing&endDate=${TODAY}`,
        ['groups'],
      ],
      [
        'trial-balance working',
        `/reports/trial-balance?mode=working&startDate=${FY}&endDate=${TODAY}`,
        ['balanced', 'totals', 'warnings'],
      ],
      [
        'cash-flow',
        `/reports/cash-flow?startDate=${FY}&endDate=${TODAY}`,
        ['accounts', 'cashTie'],
      ],
      ['ar-aging', `/reports/ar-aging`, ['insights']],
      ['ap-aging', `/reports/ap-aging`, ['insights']],
      [
        'inventory-valuation as-of',
        `/reports/inventory-valuation?asOfDate=${TODAY}`,
        ['ledgerTie', 'coverage'],
      ],
    ];
    for (const [name, path, keys] of raw) {
      const r = await get(path);
      ok(`${email}: ${name} 200`, r.status === 200, r.body);
      ok(
        `${email}: ${name} has v2 fields`,
        keys.every((k) => r.body && k in r.body),
        Object.keys(r.body ?? {}),
      );
      ok(`${email}: ${name} within budget`, r.ms <= BUDGET_MS, `${r.ms} ms`);
      console.log(
        `  ${email.padEnd(24)} ${name.padEnd(18)} ${String(r.ms).padStart(4)} ms`,
      );
    }
    const csv = await get(
      `/reports/balance-sheet?asOfDate=${TODAY}&format=csv`,
    );
    ok(
      `${email}: balance-sheet CSV keeps its old columns`,
      typeof csv.body === 'string' &&
        csv.body.split('\n')[0] ===
          'asOfDate,assets,liabilities,equity,totalAssets,totalLiabilities,totalEquity,isBalanced',
      String(csv.body).split('\n')[0],
    );
    const tb = await get(
      `/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31`,
    );
    ok(
      `${email}: trial-balance without mode is unchanged`,
      JSON.stringify(Object.keys(tb.body)) ===
        JSON.stringify([
          'range',
          'rows',
          'totalDebits',
          'totalCredits',
          'isBalanced',
        ]),
      Object.keys(tb.body ?? {}),
    );
  }
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
