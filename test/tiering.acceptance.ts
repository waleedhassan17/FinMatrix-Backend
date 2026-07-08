/**
 * FinMatrix.md — Three-tier acceptance (Phase 5)
 * ==============================================
 * Runs against a server seeded with the three demo companies
 * (`npm run seed:tier-demos`). Verifies, over the real HTTP surface:
 *
 *   1. /auth/me carries companyType + feature flags per tier.
 *   2. Feature-flag enforcement: the 403 matrix per type — small business
 *      blocked from payroll/inventory/delivery/budgets/team; large org
 *      blocked from delivery/PO/sales-orders/agencies even with inventory
 *      toggled on; warehouse open everywhere.
 *   3. Large-org inventory toggle: off → 403, super-admin toggles on → 200,
 *      delivery STILL 403.
 *   4. Kill switch: allFeaturesUnlocked=true restores everything for a
 *      small business instantly; off again → 403 again.
 *   5. Delivery-personnel role: rider sees own deliveries, 403 on every
 *      accounting/reporting endpoint even on the warehouse tier.
 *   6. The six plans: two per type from GET /billing/plans, PKR pricing,
 *      6-month cheaper per month; buying another type's plan → 400.
 *   7. Registration E2E: signup → choose type → company created with the
 *      type → payment submitted → approvals → signin lands with the right
 *      type, plan and expiry (start + durationMonths).
 *   8. Service-only invoice (small business) posts NO COGS and the books
 *      stay balanced.
 *
 * Usage:
 *   API_BASE=http://localhost:3001/api/v1 \
 *   PG_URL=postgres://user:pass@localhost:5432/db \
 *   npm run test:tiering
 */
export {};
/* eslint-disable @typescript-eslint/no-var-requires */
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3001/api/v1';
const PG_URL = process.env.PG_URL as string | undefined;
const SUPER_EMAIL = process.env.SUPER_EMAIL || 'waleedhassansfd@gmail.com';
const SUPER_PASSWORD = process.env.SUPER_PASSWORD || 'Waleed@104';
const SB_EMAIL = process.env.SB_EMAIL || 'sukoon@gmail.com';
const LO_EMAIL = process.env.LO_EMAIL || 'metromatrix@gmail.com';
const WH_EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const WH_RIDER_EMAIL = process.env.WH_RIDER_EMAIL || 'rider1@warehouseco.com';
const PASSWORD = process.env.DEMO_PASSWORD || '123456';

let pass = 0;
let fail = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail)?.slice(0, 160) : ''}`); }
}
const approx = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps;

interface Res { status: number; body: any }
async function req(method: string, path: string, opts: { token?: string; companyId?: string; json?: any } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.companyId) headers['x-company-id'] = opts.companyId;
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  let r = await fetch(`${API}${path}`, { method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined });
  for (let retry = 0; r.status === 429 && retry < 4; retry++) {
    console.log('    (throttled — waiting 20s)');
    await new Promise(res => setTimeout(res, 20_000));
    r = await fetch(`${API}${path}`, { method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined });
  }
  let body: any = null;
  try { body = await r.json(); } catch { /* empty */ }
  return { status: r.status, body };
}
const data = (r: Res) => r.body?.data ?? r.body;

async function signin(email: string, password: string): Promise<{ token: string; companyId: string; me: any }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await req('POST', '/auth/signin', { json: { email, password } });
    if (r.status === 429) { console.log('    (signin throttled — waiting 15s)'); await new Promise(res => setTimeout(res, 15_000)); continue; }
    const d = data(r);
    return { token: d?.tokens?.accessToken, companyId: d?.user?.companyId, me: d };
  }
  return { token: '', companyId: '', me: null };
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function submitPayment(token: string, companyId: string, plan: string): Promise<Res> {
  const fd = new FormData();
  fd.append('plan', plan);
  fd.append('screenshot', new Blob([PNG], { type: 'image/png' }), 'receipt.png');
  const r = await fetch(`${API}/billing/submit`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-company-id': companyId },
    body: fd as any,
  });
  const body: any = await r.json().catch(() => null);
  return { status: r.status, body };
}

async function main() {
  console.log(`\n=== FinMatrix three-tier acceptance @ ${API} ===\n`);

  // ── Sign in the cast ──
  console.log('— Setup: demo company sign-ins');
  const superU = await signin(SUPER_EMAIL, SUPER_PASSWORD);
  ok('super-admin signs in', !!superU.token);
  const sb = await signin(SB_EMAIL, PASSWORD);
  const lo = await signin(LO_EMAIL, PASSWORD);
  const wh = await signin(WH_EMAIL, PASSWORD);
  ok('three demo admins sign in', !!sb.token && !!lo.token && !!wh.token,
    { sb: !!sb.token, lo: !!lo.token, wh: !!wh.token });
  if (!sb.token || !lo.token || !wh.token || !superU.token) {
    console.error('Cannot continue — run `npm run seed:tier-demos` first.');
    process.exit(1);
  }

  // ── 1. companyType + features on the session ──
  console.log('\n— 1. Session carries type + features');
  ok('Sukoon is small_business', sb.me?.companyType === 'small_business', sb.me?.companyType);
  ok('MetroMatrix is large_org', lo.me?.companyType === 'large_org', lo.me?.companyType);
  ok('Warehouse Co is warehouse', wh.me?.companyType === 'warehouse', wh.me?.companyType);
  ok('small business flags: no payroll/inventory/delivery',
    sb.me?.features?.payroll === false && sb.me?.features?.inventory === false && sb.me?.features?.delivery === false,
    sb.me?.features);
  ok('large org flags: payroll yes, delivery no', lo.me?.features?.payroll === true && lo.me?.features?.delivery === false, lo.me?.features);
  ok('warehouse flags: everything on', wh.me?.features?.delivery === true && wh.me?.features?.inventory === true && wh.me?.features?.payroll === true, wh.me?.features);

  // ── 2. The 403 matrix ──
  console.log('\n— 2. Feature-flag enforcement (server-side 403 matrix)');
  const probe = async (who: { token: string; companyId: string }, path: string) =>
    (await req('GET', path, { token: who.token, companyId: who.companyId })).status;

  // Small business: accounting yes, everything optional no.
  ok('SB invoices 200', (await probe(sb, '/invoices')) === 200);
  ok('SB estimates 200', (await probe(sb, '/estimates')) === 200);
  ok('SB trial balance 200', (await probe(sb, '/reports/trial-balance')) === 200);
  for (const p of ['/employees', '/payroll/runs', '/inventory/items', '/deliveries', '/budgets', '/purchase-orders', '/sales-orders', '/agencies', '/reconciliations', '/settings/users']) {
    ok(`SB ${p} → 403`, (await probe(sb, p)) === 403);
  }
  // Large org: people/planning yes; warehouse world no.
  for (const p of ['/employees', '/payroll/runs', '/budgets', '/reconciliations', '/settings/users']) {
    ok(`LO ${p} → 200`, (await probe(lo, p)) === 200);
  }
  for (const p of ['/deliveries', '/purchase-orders', '/sales-orders', '/agencies', '/inventory/items']) {
    ok(`LO ${p} → 403 (inventory toggle off)`, (await probe(lo, p)) === 403);
  }
  // Warehouse: open everywhere.
  for (const p of ['/deliveries', '/purchase-orders', '/sales-orders', '/inventory/items', '/employees', '/budgets']) {
    ok(`WH ${p} → 200`, (await probe(wh, p)) === 200);
  }

  // ── 3. Large-org inventory toggle ──
  console.log('\n— 3. Large-org inventory toggle (super-admin)');
  const toggleOn = await req('PATCH', `/super-admin/companies/${lo.companyId}/feature-override`, {
    token: superU.token, json: { inventoryEnabled: true },
  });
  ok('toggle inventory ON', toggleOn.status === 200, toggleOn.status);
  ok('LO inventory now 200', (await probe(lo, '/inventory/items')) === 200);
  ok('LO deliveries STILL 403', (await probe(lo, '/deliveries')) === 403);
  ok('LO purchase orders STILL 403', (await probe(lo, '/purchase-orders')) === 403);
  await req('PATCH', `/super-admin/companies/${lo.companyId}/feature-override`, {
    token: superU.token, json: { inventoryEnabled: false },
  });
  ok('toggle reverted → 403 again', (await probe(lo, '/inventory/items')) === 403);

  // ── 4. Kill switch ──
  console.log('\n— 4. Kill switch (allFeaturesUnlocked, checked before the type gate)');
  const unlock = await req('PATCH', `/super-admin/companies/${sb.companyId}/feature-override`, {
    token: superU.token, json: { allFeaturesUnlocked: true },
  });
  ok('kill switch ON for Sukoon', unlock.status === 200 && data(unlock)?.allFeaturesUnlocked === true, unlock.body);
  ok('Sukoon deliveries now 200 (type still small_business)', (await probe(sb, '/deliveries')) === 200);
  ok('Sukoon payroll now 200', (await probe(sb, '/employees')) === 200);
  const meUnlocked = await req('GET', '/auth/me', { token: sb.token, companyId: sb.companyId });
  ok('flags in /me reflect the unlock', data(meUnlocked)?.features?.delivery === true, data(meUnlocked)?.features);
  await req('PATCH', `/super-admin/companies/${sb.companyId}/feature-override`, {
    token: superU.token, json: { allFeaturesUnlocked: false },
  });
  ok('kill switch OFF → 403 again', (await probe(sb, '/deliveries')) === 403);

  // ── 5. Delivery-personnel role (warehouse tier) ──
  console.log('\n— 5. Rider portal isolation');
  const rider = await signin(WH_RIDER_EMAIL, PASSWORD);
  ok('warehouse rider signs in', !!rider.token);
  if (rider.token) {
    const riderProbe = async (path: string) =>
      (await req('GET', path, { token: rider.token, companyId: wh.companyId })).status;
    ok('rider sees own deliveries (200)', (await riderProbe('/deliveries')) === 200);
    for (const p of ['/reports/trial-balance', '/reports/profit-loss', '/accounts', '/ledger', '/journal-entries', '/invoices', '/settings/users']) {
      ok(`rider ${p} → 403`, (await riderProbe(p)) === 403);
    }
    const riderPost = await req('POST', '/payments', { token: rider.token, companyId: wh.companyId, json: { amount: '1' } });
    ok('rider POST /payments → 403', riderPost.status === 403, riderPost.status);
  }

  // ── 6. The six plans ──
  console.log('\n— 6. PLAN_CONFIG: six plans, PKR, 6-month cheaper per month');
  const expected: Record<string, Array<{ key: string; months: number; monthly: number; total: number }>> = {
    small_business: [
      { key: 'small_business_3mo', months: 3, monthly: 250000, total: 750000 },
      { key: 'small_business_6mo', months: 6, monthly: 200000, total: 1200000 },
    ],
    large_org: [
      { key: 'large_org_3mo', months: 3, monthly: 500000, total: 1500000 },
      { key: 'large_org_6mo', months: 6, monthly: 400000, total: 2400000 },
    ],
    warehouse: [
      { key: 'warehouse_3mo', months: 3, monthly: 400000, total: 1200000 },
      { key: 'warehouse_6mo', months: 6, monthly: 300000, total: 1800000 },
    ],
  };
  for (const [type, plans] of Object.entries(expected)) {
    const r = await req('GET', `/billing/plans?companyType=${type}`, { token: wh.token, companyId: wh.companyId });
    const got = data(r)?.plans ?? [];
    ok(`${type}: exactly TWO plans offered`, got.length === 2, got.length);
    for (const exp of plans) {
      const p = got.find((x: any) => x.key === exp.key);
      ok(`${exp.key}: ${exp.months}mo, Rs ${exp.monthly / 100}/mo, Rs ${exp.total / 100} total (PKR)`,
        !!p && p.durationMonths === exp.months && p.monthlyMinorUnits === exp.monthly &&
        p.totalMinorUnits === exp.total && p.currency === 'PKR', p);
    }
    const three = got.find((x: any) => x.durationMonths === 3);
    const six = got.find((x: any) => x.durationMonths === 6);
    ok(`${type}: 6-month cheaper per month (savings labeled)`,
      !!three && !!six && six.monthlyMinorUnits < three.monthlyMinorUnits && !!six.monthlySavingsLabel,
      { three: three?.monthlyMinorUnits, six: six?.monthlyMinorUnits });
  }
  // Super-admin plans view serves the SAME six tier plans (config-defined).
  const adminPlans = await req('GET', '/super-admin/plans', { token: superU.token });
  const adminList = data(adminPlans) ?? [];
  ok('super-admin plans lists exactly the six tier plans',
    Array.isArray(adminList) && adminList.length === 6 &&
    adminList.every((p: any) => p.companyType && p.totalLabel && p.currency === 'PKR'),
    adminList.length);
  const publicPlans = await req('GET', '/super-admin/plans/public', {});
  const publicList = data(publicPlans) ?? [];
  ok('public plans endpoint serves the six tier plans too',
    Array.isArray(publicList) && publicList.length === 6, publicList.length);
  const editAttempt = await req('POST', '/super-admin/plans', {
    token: superU.token,
    json: { name: 'Hack Plan', priceMonthly: 1, priceYearly: 1, maxUsers: 1 },
  });
  ok('creating/editing plans via API rejected (config-defined)',
    editAttempt.status === 400 && JSON.stringify(editAttempt.body).includes('PLANS_CONFIG_DEFINED'),
    editAttempt.status);

  const mismatch = await submitPayment(sb.token, sb.companyId, 'warehouse_3mo');
  ok('small business buying a warehouse plan → 400 PLAN_TYPE_MISMATCH',
    mismatch.status === 400 && JSON.stringify(mismatch.body).includes('PLAN_TYPE_MISMATCH'), mismatch.body);

  // ── 7. Registration E2E: signup → type → plan → approvals → right features ──
  console.log('\n— 7. Registration sets type + plan + expiry');
  const email = `qa_tier_${Date.now()}@qa.local`;
  const signup = await req('POST', '/auth/signup', {
    json: { email, password: 'Qa@12345', displayName: 'QA Tier Admin', phone: '+92-300-1234567', role: 'admin' },
  });
  const t0 = data(signup)?.tokens?.accessToken;
  const newUserId = data(signup)?.user?.id;
  ok('signup', !!t0 && !!newUserId, signup.status);
  const createCo = await req('POST', '/companies', {
    token: t0, json: { name: `QA Tier Co ${Date.now()}`, industry: 'Retail', companyType: 'small_business' },
  });
  const newCid = data(createCo)?.id;
  ok('company created WITH companyType', createCo.status < 300 && !!newCid, createCo.body);
  if (PG_URL) {
    const pg = new Client({ connectionString: PG_URL });
    await pg.connect();
    await pg.query(`UPDATE users SET is_email_verified = true WHERE id = $1`, [newUserId]);
    await pg.end();
  }
  const paySubmit = await submitPayment(t0, newCid, 'small_business_3mo');
  ok('payment submitted for small_business_3mo', paySubmit.status < 300, paySubmit.body);
  const submissionId = data(paySubmit)?.id;
  await req('POST', `/companies/${newCid}/submit`, { token: t0, companyId: newCid });
  const approveCo = await req('PATCH', `/admin/companies/${newCid}/approve`, { token: superU.token });
  ok('company approved', approveCo.status < 300, approveCo.status);
  const approvePay = await req('PATCH', `/admin/payment-submissions/${submissionId}/approve`, { token: superU.token });
  ok('payment approved (plan activates)', approvePay.status < 300, approvePay.body);
  const fresh = await signin(email, 'Qa@12345');
  ok('fresh signin: companyType small_business + gated flags',
    fresh.me?.companyType === 'small_business' && fresh.me?.features?.delivery === false, fresh.me?.companyType);
  const status = data(await req('GET', '/billing/status', { token: fresh.token, companyId: newCid }));
  const expiry = status?.expiryDate ? new Date(status.expiryDate) : null;
  const monthsOut = expiry ? (expiry.getTime() - Date.now()) / (30.44 * 86400000) : 0;
  ok('plan = small_business_3mo, expiry ≈ 3 months out',
    status?.plan === 'small_business_3mo' && monthsOut > 2.5 && monthsOut < 3.5,
    { plan: status?.plan, expiry: status?.expiryDate });

  // ── 8. Service-only invoice: no COGS, books balanced ──
  console.log('\n— 8. Service-only invoice (small business) posts no COGS');
  const custId = (data(await req('POST', '/customers', { token: sb.token, companyId: sb.companyId, json: { name: 'QA Service Customer' } })))?.id;
  const cogsBefore = Number((data(await req('GET', '/reports/profit-loss?startDate=1970-01-01&endDate=2999-12-31', { token: sb.token, companyId: sb.companyId })))?.cogs ?? 0);
  const inv = await req('POST', '/invoices', {
    token: sb.token, companyId: sb.companyId,
    json: {
      customerId: custId, invoiceDate: new Date().toISOString().slice(0, 10), dueDate: new Date().toISOString().slice(0, 10),
      status: 'sent', lines: [{ description: 'Consulting service', quantity: '2', unitPrice: '5000', taxRate: '0' }],
    },
  });
  ok('service invoice posts', inv.status < 300, inv.status);
  const plAfter = data(await req('GET', '/reports/profit-loss?startDate=1970-01-01&endDate=2999-12-31', { token: sb.token, companyId: sb.companyId }));
  ok('COGS unchanged (revenue only)', approx(Number(plAfter?.cogs ?? 0), cogsBefore), { before: cogsBefore, after: plAfter?.cogs });
  const tb = data(await req('GET', '/reports/trial-balance', { token: sb.token, companyId: sb.companyId })) ??
    (await req('GET', '/reports/trial-balance', { token: sb.token, companyId: sb.companyId })).body;
  ok('Trial Balance still balances', tb?.isBalanced === true, { dr: tb?.totalDebits, cr: tb?.totalCredits });

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) { console.log('Failures:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
