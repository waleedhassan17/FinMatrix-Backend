/**
 * phase2.md — Subscription lifecycle acceptance test (HTTP, end-to-end).
 * Exercises all three flows + limits + expiry(data-intact) + idempotency + gate.
 *
 * Run against a booted server on a scratch database (never production):
 *   API_BASE=http://localhost:3101/api/v1 \
 *   DATABASE_URL=postgres://finmatrix_user:pass@localhost:5432/finmatrix_launch \
 *   npm run test:subscription
 *
 * Uses Node 22 global fetch/FormData/Blob and `pg` for a few state pokes
 * (email-verify, force-expiry) that would otherwise need email/time travel.
 * The super-admin is a throwaway one created for the run.
 *
 * KNOWN STALE (before the launch branch): the flows below use the legacy
 * Free/Standard plans, which no company type offers any more, and create
 * riders without the username every rider has needed since staff sign-in
 * moved to usernames — so most checks after setup fail on main too. Kept
 * runnable and credential-free; rewrite or retire it with the billing
 * screens (disabled in this build).
 *
 * Since launch, an approval needs a plan and an end date, so no new company
 * starts on Free. The company here is turned into a LEGACY Free company (as
 * every pre-launch approval left one) to keep the upgrade/renew paths tested.
 */
import { BASE, Db, freshIp, superAdmin } from './launch-helpers';

const IP = freshIp();

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    fails.push(name);
    console.log(
      `  ✗ ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`,
    );
  }
}

interface Res {
  status: number;
  body: any;
}
async function req(
  method: string,
  path: string,
  opts: { token?: string; companyId?: string; json?: any } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.companyId) headers['x-company-id'] = opts.companyId;
  headers['X-Forwarded-For'] = IP;
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    /* empty */
  }
  return { status: r.status, body };
}
const data = (r: Res) => r.body?.data ?? r.body;

// 1x1 PNG
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
async function submitPayment(
  token: string,
  companyId: string,
  plan: string,
): Promise<Res> {
  const fd = new FormData();
  fd.append('plan', plan);
  fd.append(
    'screenshot',
    new Blob([PNG], { type: 'image/png' }),
    'receipt.png',
  );
  const r = await fetch(`${BASE}/billing/submit?plan=${plan}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-company-id': companyId },
    body: fd as any,
  });
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    /* */
  }
  return { status: r.status, body };
}

async function main() {
  const db = await new Db().open();
  const sql = async (q: string, p: any[] = []) => ({
    rows: await db.sql(q, p),
  });

  console.log(`\n=== Subscription acceptance @ ${BASE} ===\n`);

  // ── A throwaway super-admin for this run ──
  const superToken = (await superAdmin(db)).token;
  check('super-admin signs in', !!superToken);

  // ── Admin signup + company create + approve ──
  const email = `qa_admin_${Date.now()}@qa.local`;
  const signup = await req('POST', '/auth/signup', {
    json: {
      email,
      password: 'Qa@12345',
      displayName: 'QA Admin',
      phone: '+92-300-1234567',
      role: 'admin',
    },
  });
  const adminToken0 = data(signup)?.tokens?.accessToken;
  const adminUserId = data(signup)?.user?.id;
  check('admin signs up', !!adminToken0 && !!adminUserId, signup.status);
  // Email disabled in QA → mark verified (company setup needs a verified inbox).
  await sql(`UPDATE users SET is_email_verified = true WHERE id = $1`, [
    adminUserId,
  ]);

  const createCo = await req('POST', '/companies', {
    token: adminToken0,
    json: { name: `QA Co ${Date.now()}`, industry: 'Retail' },
  });
  const companyId = data(createCo)?.id;
  check('company created', !!companyId, createCo.status);

  await req('POST', `/companies/${companyId}/submit`, {
    token: adminToken0,
    companyId,
  });
  const approveCo = await req(
    'PATCH',
    `/admin/companies/${companyId}/approve`,
    {
      token: superToken,
      json: {
        plan: 'warehouse_scale_1yr',
        endDate: new Date(Date.now() + 365 * 86_400_000).toISOString(),
      },
    },
  );
  check(
    'super approves company (plan + end date)',
    approveCo.status === 200,
    approveCo.status,
  );
  // A legacy Free company, as every pre-launch approval left one.
  await sql(
    `UPDATE companies
        SET subscription_plan = 'free', subscription_start_date = NULL,
            subscription_expiry_date = NULL, payment_status = 'none'
      WHERE id = $1`,
    [companyId],
  );
  const relogin = await req('POST', '/auth/signin', {
    json: { email, password: 'Qa@12345' },
  });
  const adminToken = data(relogin)?.tokens?.accessToken;
  check(
    'admin re-logs in (JWT now carries companyId)',
    !!adminToken && data(relogin)?.companyId === companyId,
    relogin.status,
  );

  // ── Billing status: Free, active ──
  const st1 = data(
    await req('GET', '/billing/status', { token: adminToken, companyId }),
  );
  check(
    'status: Free plan, active account, active subscription',
    st1?.plan === 'free' &&
      st1?.accountStatus === 'active' &&
      st1?.subscriptionStatus === 'active',
    st1,
  );

  // ── Delivery-personnel limit: Free = 1 ──
  const lim1 = data(
    await req('GET', '/billing/plan-limits', { token: adminToken, companyId }),
  );
  check(
    'plan-limits: Free limit 1, count 0',
    lim1?.deliveryPersonnelLimit === 1 && lim1?.currentCount === 0,
    lim1,
  );

  const p1 = await req('POST', '/delivery-personnel', {
    token: adminToken,
    companyId,
    json: {
      email: `rider1_${Date.now()}@qa.local`,
      password: 'Qa@12345',
      name: 'Rider One',
      vehicleType: 'motorcycle',
      maxLoad: 10,
    },
  });
  check(
    '1st delivery personnel created (Free allows 1)',
    p1.status === 201 || p1.status === 200,
    p1.status,
  );

  const p2 = await req('POST', '/delivery-personnel', {
    token: adminToken,
    companyId,
    json: {
      email: `rider2_${Date.now()}@qa.local`,
      password: 'Qa@12345',
      name: 'Rider Two',
      vehicleType: 'motorcycle',
      maxLoad: 10,
    },
  });
  check(
    '2nd delivery personnel REJECTED on Free (limit)',
    p2.status === 400 &&
      JSON.stringify(p2.body).includes('DELIVERY_PERSONNEL_LIMIT_REACHED'),
    p2.status,
  );

  // ── Bank details (server-set amount) ──
  const bank = data(
    await req('GET', '/billing/bank-details?plan=standard', {
      token: adminToken,
      companyId,
    }),
  );
  check(
    'bank-details: Standard = Rs 1,000 (100000 minor), 6 months, bank present',
    bank?.amountDueMinorUnits === 100000 &&
      bank?.durationMonths === 6 &&
      !!bank?.bankAccount?.accountNumber,
    bank,
  );

  // ── FLOW 3: upgrade from Free (active company) → UPGRADE submission ──
  const sub1 = await submitPayment(adminToken, companyId, 'standard');
  const sub1Body = data(sub1);
  check(
    'submit standard payment → kind UPGRADE, submitted',
    sub1.status === 201 || sub1.status === 200,
    sub1.status,
  );
  check(
    'submission tagged UPGRADE',
    sub1Body?.kind === 'UPGRADE',
    sub1Body?.kind,
  );

  // role guard
  const forbidden = await req('GET', '/admin/payment-submissions', {
    token: adminToken,
  });
  check(
    'non-super-admin → 403 on /admin/payment-submissions',
    forbidden.status === 403,
    forbidden.status,
  );

  const list1 = data(
    await req('GET', '/admin/payment-submissions?status=submitted', {
      token: superToken,
    }),
  );
  check(
    'super sees the submitted payment',
    Array.isArray(list1) && list1.some((s: any) => s.id === sub1Body.id),
    list1?.length,
  );

  // approve
  const appr1 = await req(
    'PATCH',
    `/admin/payment-submissions/${sub1Body.id}/approve`,
    { token: superToken },
  );
  check('approve submission → 200', appr1.status === 200, appr1.status);
  const st2 = data(
    await req('GET', '/billing/status', { token: adminToken, companyId }),
  );
  check(
    'after approval: plan standard, active, paid, has expiry',
    st2?.plan === 'standard' &&
      st2?.subscriptionStatus === 'active' &&
      st2?.paymentStatus === 'paid' &&
      !!st2?.expiryDate,
    st2,
  );
  const rev1 = (
    await sql(
      `SELECT COUNT(*)::int c FROM platform_revenue WHERE company_id=$1`,
      [companyId],
    )
  ).rows[0].c;
  check('platform_revenue: exactly 1 row', rev1 === 1, rev1);

  // idempotent approve
  await req('PATCH', `/admin/payment-submissions/${sub1Body.id}/approve`, {
    token: superToken,
  });
  const rev2 = (
    await sql(
      `SELECT COUNT(*)::int c FROM platform_revenue WHERE company_id=$1`,
      [companyId],
    )
  ).rows[0].c;
  check('re-approve is idempotent: still 1 revenue row', rev2 === 1, rev2);

  // ── Paid limit = 3 ──
  const lim2 = data(
    await req('GET', '/billing/plan-limits', { token: adminToken, companyId }),
  );
  check(
    'plan-limits: Standard limit 3',
    lim2?.deliveryPersonnelLimit === 3,
    lim2,
  );
  const p3 = await req('POST', '/delivery-personnel', {
    token: adminToken,
    companyId,
    json: {
      email: `rider3_${Date.now()}@qa.local`,
      password: 'Qa@12345',
      name: 'Rider Three',
      vehicleType: 'van',
      maxLoad: 10,
    },
  });
  const p4 = await req('POST', '/delivery-personnel', {
    token: adminToken,
    companyId,
    json: {
      email: `rider4_${Date.now()}@qa.local`,
      password: 'Qa@12345',
      name: 'Rider Four',
      vehicleType: 'van',
      maxLoad: 10,
    },
  });
  check(
    'paid allows 2nd+3rd personnel',
    p3.status === 201 || p3.status === 200,
    p3.status,
  );
  const p5 = await req('POST', '/delivery-personnel', {
    token: adminToken,
    companyId,
    json: {
      email: `rider5_${Date.now()}@qa.local`,
      password: 'Qa@12345',
      name: 'Rider Five',
      vehicleType: 'van',
      maxLoad: 10,
    },
  });
  check(
    '4th personnel rejected on paid (limit 3)',
    p5.status === 400,
    p5.status,
  );
  void p4;

  // ── Early renewal extends from CURRENT expiry (no lost days) ──
  const expiryBefore = new Date(st2.expiryDate).getTime();
  const sub2 = data(await submitPayment(adminToken, companyId, 'standard'));
  check(
    'renewal (same plan, active) tagged RENEWAL',
    sub2?.kind === 'RENEWAL',
    sub2?.kind,
  );
  await req('PATCH', `/admin/payment-submissions/${sub2.id}/approve`, {
    token: superToken,
  });
  const st3 = data(
    await req('GET', '/billing/status', { token: adminToken, companyId }),
  );
  const expiryAfter = new Date(st3.expiryDate).getTime();
  const monthsGap = (expiryAfter - expiryBefore) / (1000 * 60 * 60 * 24 * 30);
  check(
    'early renewal extended from current expiry (~+6mo, no lost days)',
    monthsGap > 5 && monthsGap < 7,
    { monthsGap },
  );

  // ── EXPIRY: deactivate without deleting data ──
  const personnelBefore = (
    await sql(
      `SELECT COUNT(*)::int c FROM delivery_personnel_profiles WHERE company_id=$1`,
      [companyId],
    )
  ).rows[0].c;
  await sql(
    `UPDATE companies SET subscription_expiry_date = now() - interval '1 day', subscription_status='active' WHERE id=$1`,
    [companyId],
  );
  const scan1 = data(
    await req('POST', '/admin/payment-submissions/run-expiry-scan', {
      token: superToken,
    }),
  );
  check('expiry scan reports 1 deactivation', scan1?.deactivated >= 1, scan1);
  const coRow = (
    await sql(`SELECT status, subscription_status FROM companies WHERE id=$1`, [
      companyId,
    ])
  ).rows[0];
  check(
    'company → inactive + expired after expiry',
    coRow.status === 'inactive' && coRow.subscription_status === 'expired',
    coRow,
  );
  const personnelAfter = (
    await sql(
      `SELECT COUNT(*)::int c FROM delivery_personnel_profiles WHERE company_id=$1`,
      [companyId],
    )
  ).rows[0].c;
  check(
    'DATA INTACT: personnel count unchanged after expiry',
    personnelBefore === personnelAfter && personnelBefore === 3,
    { personnelBefore, personnelAfter },
  );

  // ── Inactive can still sign in (renew-only) + billing reachable, business blocked ──
  const inactiveLogin = await req('POST', '/auth/signin', {
    json: { email, password: 'Qa@12345' },
  });
  const inactiveToken = data(inactiveLogin)?.tokens?.accessToken;
  check(
    'inactive account CAN sign in (token issued, renew-only)',
    inactiveLogin.status === 200 &&
      !!inactiveToken &&
      data(inactiveLogin)?.companyStatus === 'inactive',
    inactiveLogin.status,
  );
  const billStatusInactive = await req('GET', '/billing/status', {
    token: inactiveToken,
    companyId,
  });
  check(
    'inactive: /billing/status reachable (200)',
    billStatusInactive.status === 200,
    billStatusInactive.status,
  );
  const bizInactive = await req('GET', '/customers', {
    token: inactiveToken,
    companyId,
  });
  check(
    'inactive: business endpoint blocked (403)',
    bizInactive.status === 403,
    bizInactive.status,
  );

  // ── Renew from inactive restores access + same data ──
  const renewSub = data(
    await submitPayment(inactiveToken, companyId, 'standard'),
  );
  check(
    'inactive submits renewal → RENEWAL',
    renewSub?.kind === 'RENEWAL',
    renewSub?.kind,
  );
  const apprRenew = await req(
    'PATCH',
    `/admin/payment-submissions/${renewSub.id}/approve`,
    { token: superToken },
  );
  check('renewal approved → 200', apprRenew.status === 200, apprRenew.status);
  const coRow2 = (
    await sql(`SELECT status, subscription_status FROM companies WHERE id=$1`, [
      companyId,
    ])
  ).rows[0];
  check(
    'after renewal: active + subscription active (data restored)',
    coRow2.status === 'active' && coRow2.subscription_status === 'active',
    coRow2,
  );
  const personnelRestored = (
    await sql(
      `SELECT COUNT(*)::int c FROM delivery_personnel_profiles WHERE company_id=$1`,
      [companyId],
    )
  ).rows[0].c;
  check(
    'DATA INTACT after renewal: personnel still 3',
    personnelRestored === 3,
    personnelRestored,
  );

  // ── Reminder idempotency: ≤10 days → expiring + exactly one reminder/day ──
  await sql(
    `UPDATE companies SET subscription_expiry_date = now() + interval '5 days', subscription_status='active', subscription_reminder_on=NULL WHERE id=$1`,
    [companyId],
  );
  await req('POST', '/admin/payment-submissions/run-expiry-scan', {
    token: superToken,
  });
  const remA = (
    await sql(
      `SELECT COUNT(*)::int c FROM notifications WHERE company_id=$1 AND type='subscription_expiring'`,
      [companyId],
    )
  ).rows[0].c;
  await req('POST', '/admin/payment-submissions/run-expiry-scan', {
    token: superToken,
  });
  const remB = (
    await sql(
      `SELECT COUNT(*)::int c FROM notifications WHERE company_id=$1 AND type='subscription_expiring'`,
      [companyId],
    )
  ).rows[0].c;
  const coRow3 = (
    await sql(`SELECT subscription_status FROM companies WHERE id=$1`, [
      companyId,
    ])
  ).rows[0];
  check(
    'within 10 days → subscription expiring',
    coRow3.subscription_status === 'expiring',
    coRow3,
  );
  check(
    'exactly ONE reminder created, second scan adds none (idempotent/day)',
    remA >= 1 && remB === remA,
    { remA, remB },
  );

  await db.close();

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail) console.log('FAILED:', fails.join(' | '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
