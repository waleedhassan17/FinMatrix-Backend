/**
 * Free trial — acceptance test (HTTP, end-to-end), in the style of
 * subscription.acceptance.ts.
 *
 * The trial is REQUESTED by the owner, APPROVED by a super-admin, and runs 30
 * days from the approval. It is the fixed `warehouse_trial` plan: every
 * feature, one delivery rider. This suite proves the parts that cost money or
 * trust when they break:
 *
 *   a. a request grants nothing — CompanyGuard and sign-in still refuse
 *   b. the 30 days run from APPROVAL, never from the request
 *   c. one trial per email and per phone, whichever client shape asks
 *   d. two simultaneous requests with one phone → exactly one succeeds
 *   e. unverified email / missing or bad phone are refused
 *   f. rejection releases the claim; rejection-with-block does not
 *   g. a company that has trialed cannot trial again
 *   h. expiry cuts access LIVE (no cron), then the scan uses trial wording,
 *      and trial-ending emails are deduped by milestone
 *   i. subscribing mid-trial ends the trial at approval (no stacked days)
 *   j. trials never create platform revenue
 *   k. rider seats: a downgrade locks riders beyond the limit; locked riders
 *      cannot sign in, work, or be reactivated; swapping and upgrading work
 *
 * Run against a booted server:
 *   BASE_URL=http://localhost:3001/api/v1 \
 *   PG_URL=postgres://finmatrix_user:pass@localhost:5432/finmatrix_qa \
 *   SUPER_EMAIL=... SUPER_PASSWORD=... \
 *   npm run test:trial
 *
 * Uses Node 22 global fetch/FormData/Blob and `pg` for the state pokes that
 * would otherwise need email or time travel (verifying an inbox, moving a
 * trial's dates).
 */
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports */
import { randomUUID } from 'crypto';
// `pg` ships no type declarations here, so it is required like the sibling suites.
const { Client } = require('pg');

const BASE = process.env.BASE_URL || 'http://localhost:3001/api/v1';
const PG_URL = process.env.PG_URL as string;
const SUPER_EMAIL = process.env.SUPER_EMAIL || 'waleedhassansfd@gmail.com';
const SUPER_PASSWORD = process.env.SUPER_PASSWORD || 'Waleed@104';
const PASSWORD = 'Qa@12345';
const DAY = 24 * 60 * 60 * 1000;

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
    console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra)?.slice(0, 300) : ''}`);
  }
}

interface Res { status: number; body: any; }
async function req(
  method: string,
  path: string,
  opts: { token?: string; companyId?: string; json?: any } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.companyId) headers['x-company-id'] = opts.companyId;
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  let body: any = null;
  try { body = await r.json(); } catch { /* empty */ }
  return { status: r.status, body };
}
const data = (r: Res) => r.body?.data ?? r.body;
const code = (r: Res) => r.body?.error?.code ?? r.body?.code;

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);
async function submitPayment(token: string, companyId: string, plan: string): Promise<Res> {
  const fd = new FormData();
  fd.append('plan', plan);
  fd.append('screenshot', new Blob([PNG], { type: 'image/png' }), 'receipt.png');
  const r = await fetch(`${BASE}/billing/submit?plan=${plan}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'x-company-id': companyId },
    body: fd as any,
  });
  let body: any = null;
  try { body = await r.json(); } catch { /* */ }
  return { status: r.status, body };
}

/** A unique, valid Pakistani mobile in local form (0300…). */
let phoneSeq = Math.floor(Math.random() * 9_000_000);
function freshPhone(): string {
  phoneSeq = (phoneSeq + 7919) % 10_000_000;
  return `0321${String(phoneSeq).padStart(7, '0')}`;
}
/** The canonical +92 form the server stores. */
const canonical = (local: string) => `+92${local.slice(1)}`;

async function main() {
  const pg = new Client({ connectionString: PG_URL });
  await pg.connect();
  const sql = async (q: string, p: any[] = []) => (await pg.query(q, p)).rows;
  const run = Date.now();

  console.log(`\n=== Free trial acceptance @ ${BASE} ===\n`);

  const superLogin = await req('POST', '/auth/signin', { json: { email: SUPER_EMAIL, password: SUPER_PASSWORD } });
  const superToken = data(superLogin)?.tokens?.accessToken;
  check('super-admin signs in', !!superToken, superLogin.status);
  if (!superToken) throw new Error('Cannot continue without a super-admin token');

  /**
   * Sign up an owner and set up a company — the steps every registration
   * requires before a trial can be asked for.
   */
  let ownerSeq = 0;
  async function owner(opts: { verified?: boolean; phone?: string | null } = {}) {
    ownerSeq += 1;
    const email = `trial_${run}_${ownerSeq}@qa.local`;
    const signup = await req('POST', '/auth/signup', {
      json: { email, password: PASSWORD, displayName: `Trial Owner ${ownerSeq}`, role: 'admin' },
    });
    const signupToken = data(signup)?.tokens?.accessToken as string;
    const userId = data(signup)?.user?.id as string;
    const phone = opts.phone === undefined ? freshPhone() : opts.phone;
    const createCo = await req('POST', '/companies', {
      token: signupToken,
      json: { name: `Trial Co ${run}-${ownerSeq}`, industry: 'Retail', ...(phone ? { phone } : {}) },
    });
    const companyId = data(createCo)?.id as string;
    if (opts.verified !== false) {
      await sql(`UPDATE users SET is_email_verified = true, email_verified_at = now() WHERE id = $1`, [userId]);
    }
    if (!signupToken || !companyId) {
      throw new Error(`owner setup failed: signup=${signup.status} company=${createCo.status} ${JSON.stringify(createCo.body)}`);
    }
    return { email, userId, signupToken, companyId, phone };
  }
  /**
   * Sign-in is throttled (5/minute per IP) — correctly, and this suite signs
   * in more often than that. Wait the window out rather than weaken the limit.
   */
  const signinWith = async (json: Record<string, string>): Promise<Res> => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const r = await req('POST', '/auth/signin', { json });
      if (r.status !== 429) return r;
      console.log('    (sign-in throttled — waiting 61s)');
      await new Promise((resolve) => setTimeout(resolve, 61_000));
    }
    return req('POST', '/auth/signin', { json });
  };
  const signin = (email: string) => signinWith({ email, password: PASSWORD });
  /** The two request shapes the clients send. */
  const requestTrialBody = (token: string, companyId: string) =>
    req('POST', '/companies/start-trial', { token, json: { companyId } }); // Expo app
  const requestTrialHeader = (token: string, companyId: string) =>
    req('POST', '/companies/start-trial', { token, companyId, json: {} }); // web (x-company-id)
  const approve = (id: string) => req('PATCH', `/admin/payment-submissions/${id}/approve`, { token: superToken });
  const reject = (id: string, blockFutureTrials?: boolean) =>
    req('PATCH', `/admin/payment-submissions/${id}/reject`, {
      token: superToken,
      json: { reason: 'QA review', ...(blockFutureTrials !== undefined ? { blockFutureTrials } : {}) },
    });
  const companyRow = async (id: string) => (await sql(`SELECT * FROM companies WHERE id = $1`, [id]))[0];
  const revenueTotal = async () => {
    const s = data(await req('GET', '/admin/payment-submissions/revenue/summary', { token: superToken }));
    return { total: s?.totalMinorUnits as number, count: s?.paymentsCount as number };
  };

  const revenueBefore = await revenueTotal();

  // ── a. A request grants nothing ─────────────────────────────────────────
  console.log('\n— a. request → still locked out');
  const A = await owner();
  // Signed in while still a draft, so this token CARRIES the companyId — the
  // strongest proof that CompanyGuard itself, not a missing claim, refuses.
  const aDraftLogin = await signin(A.email);
  const aToken = data(aDraftLogin)?.tokens?.accessToken as string;
  check('draft owner can sign in (onboarding)', aDraftLogin.status === 200 && data(aDraftLogin)?.companyId === A.companyId, aDraftLogin.status);

  const aReq = await requestTrialBody(aToken, A.companyId);
  const aReqBody = data(aReq);
  check('trial request → 201 pending_approval', aReq.status === 201 && aReqBody?.status === 'pending_approval', aReq.body);
  check('response carries 24h estimate + trial plan', aReqBody?.estimatedActivationHours === 24 && aReqBody?.requestedPlanKey === 'warehouse_trial', aReqBody);
  check('response carries the billing-status shape with trialPending', aReqBody?.billing?.trialPending === true && aReqBody?.billing?.accountStatus === 'draft', aReqBody?.billing);

  let aRow = await companyRow(A.companyId);
  check(
    'request set ONLY paymentStatus/lastSubmission/trialRequestedAt',
    aRow.status === 'email_verified' &&
      aRow.payment_status === 'submitted' &&
      aRow.trial_requested_at != null &&
      aRow.is_trial === false &&
      aRow.trial_started_at === null &&
      aRow.subscription_expiry_date === null &&
      aRow.subscription_plan === 'free',
    aRow,
  );

  const aGuard = await req('GET', '/customers', { token: aToken, companyId: A.companyId });
  check('CompanyGuard refuses the pending company (403 COMPANY_NOT_ACTIVE, pending)', aGuard.status === 403 && code(aGuard) === 'COMPANY_NOT_ACTIVE', aGuard.body);
  const aRiders = await req('GET', '/delivery-personnel', { token: aToken, companyId: A.companyId });
  check('…and every other business route', aRiders.status === 403, aRiders.status);

  const aPendingLogin = await signin(A.email);
  check(
    'sign-in blocked with COMPANY_PENDING + details.pendingKind=trial',
    aPendingLogin.status === 403 && code(aPendingLogin) === 'COMPANY_PENDING' && aPendingLogin.body?.error?.details?.pendingKind === 'trial',
    aPendingLogin.body,
  );
  const aMe = data(await req('GET', '/auth/me', { token: aToken }));
  check('/auth/me reports pending', aMe?.companyStatus === 'pending', aMe?.companyStatus);

  const aSecond = await requestTrialHeader(aToken, A.companyId);
  check('second request from the same company → 409 REQUEST_PENDING_REVIEW', aSecond.status === 409 && code(aSecond) === 'REQUEST_PENDING_REVIEW', aSecond.body);

  const aPay = await submitPayment(aToken, A.companyId, 'warehouse_starter_6mo');
  check('payment cannot be stacked on a pending trial (409)', aPay.status === 409 && code(aPay) === 'REQUEST_PENDING_REVIEW', aPay.body);

  const list = data(await req('GET', '/admin/payment-submissions?status=submitted&kind=TRIAL&order=asc', { token: superToken }));
  const aListed = Array.isArray(list) ? list.find((s: any) => s.id === aReqBody.submissionId) : null;
  check(
    'admin queue lists it under kind=TRIAL with requester + age',
    !!aListed && aListed.kind === 'TRIAL' && aListed.requesterEmail === A.email && aListed.requesterPhone === canonical(A.phone as string) && typeof aListed.ageHours === 'number' && aListed.hasScreenshot === false,
    aListed,
  );
  const paymentsOnly = data(await req('GET', '/admin/payment-submissions?kind=PAYMENT', { token: superToken }));
  check('kind=PAYMENT excludes trials', Array.isArray(paymentsOnly) && paymentsOnly.every((s: any) => s.kind !== 'TRIAL'), paymentsOnly?.length);

  // ── b. The 30 days run from APPROVAL ────────────────────────────────────
  console.log('\n— b. approve → clock starts at approval');
  // The request was "made" three days ago. A clock-starts-at-request bug
  // would put the expiry 27 days out; the right answer is 30.
  await sql(
    `UPDATE companies SET trial_requested_at = now() - interval '3 days' WHERE id = $1`,
    [A.companyId],
  );
  await sql(
    `UPDATE platform_payment_submissions SET created_at = now() - interval '3 days' WHERE id = $1`,
    [aReqBody.submissionId],
  );
  const aApprove = await approve(aReqBody.submissionId);
  check('approve trial → 200', aApprove.status === 200, aApprove.body);
  aRow = await companyRow(A.companyId);
  const sub = (await sql(`SELECT * FROM platform_payment_submissions WHERE id = $1`, [aReqBody.submissionId]))[0];
  const expiry = new Date(aRow.subscription_expiry_date).getTime();
  const reviewedAt = new Date(sub.reviewed_at).getTime();
  const requestedAt = new Date(aRow.trial_requested_at).getTime();
  check('expiry = approval + 30 days (±60s)', Math.abs(expiry - (reviewedAt + 30 * DAY)) < 60_000, { expiry: aRow.subscription_expiry_date, reviewed: sub.reviewed_at });
  check('expiry is NOT request + 30 days', Math.abs(expiry - (requestedAt + 30 * DAY)) > 2 * DAY, { requested: aRow.trial_requested_at });
  check('trial_started_at = approval', Math.abs(new Date(aRow.trial_started_at).getTime() - reviewedAt) < 60_000, aRow.trial_started_at);
  check(
    'company active on the trial plan, isTrial, paymentStatus none, subscription active',
    aRow.status === 'active' && aRow.is_trial === true && aRow.subscription_plan === 'warehouse_trial' && aRow.payment_status === 'none' && aRow.subscription_status === 'active' && aRow.trial_converted_at === null,
    aRow,
  );
  const claimA = (await sql(`SELECT status, decided_at FROM trial_claims WHERE submission_id = $1`, [aReqBody.submissionId]))[0];
  check('claim → approved', claimA?.status === 'approved' && claimA.decided_at != null, claimA);
  const aRevenueRows = (await sql(`SELECT COUNT(*)::int c FROM platform_revenue WHERE company_id = $1`, [A.companyId]))[0].c;
  check('no platform_revenue row for a trial', aRevenueRows === 0, aRevenueRows);
  await approve(aReqBody.submissionId);
  const aRevenueRows2 = (await sql(`SELECT COUNT(*)::int c FROM platform_revenue WHERE company_id = $1`, [A.companyId]))[0].c;
  check('re-approve is idempotent and still records no revenue', aRevenueRows2 === 0, aRevenueRows2);

  const aActiveLogin = await signin(A.email);
  const aActiveToken = data(aActiveLogin)?.tokens?.accessToken as string;
  check('approved owner signs in → active', aActiveLogin.status === 200 && data(aActiveLogin)?.companyStatus === 'active', aActiveLogin.body);
  check('signin carries subscription.isTrial', data(aActiveLogin)?.subscription?.isTrial === true && data(aActiveLogin)?.subscription?.plan === 'warehouse_trial', data(aActiveLogin)?.subscription);
  const aBiz = await req('GET', '/customers', { token: aActiveToken, companyId: A.companyId });
  check('business endpoints open immediately (200)', aBiz.status === 200, aBiz.status);
  const aStatus = data(await req('GET', '/billing/status', { token: aActiveToken, companyId: A.companyId }));
  check('billing status: isTrial, 30 days remaining, not pending, expires', aStatus?.isTrial === true && aStatus?.trialDaysRemaining === 30 && aStatus?.trialPending === false && aStatus?.neverExpires === false, aStatus);
  const aMeActive = data(await req('GET', '/auth/me', { token: aActiveToken }));
  check('/auth/me subscription: trial, not converted', aMeActive?.subscription?.isTrial === true && aMeActive?.subscription?.trialConvertedAt === null, aMeActive?.subscription);

  // ── j. Revenue ──────────────────────────────────────────────────────────
  const revenueAfterTrial = await revenueTotal();
  check('j. revenue summary unchanged by a trial approval', revenueAfterTrial.total === revenueBefore.total && revenueAfterTrial.count === revenueBefore.count, { revenueBefore, revenueAfterTrial });

  // ── g. Already trialed ──────────────────────────────────────────────────
  console.log('\n— g. a company that has trialed cannot trial again');
  const aAgain = await requestTrialBody(aActiveToken, A.companyId);
  check('→ 403 TRIAL_ALREADY_USED', aAgain.status === 403 && code(aAgain) === 'TRIAL_ALREADY_USED', aAgain.body);

  // ── c. One trial per email and per phone, both client shapes ───────────
  console.log('\n— c. duplicate email / phone, both request shapes');
  // Same owner (same email), a second company with a fresh phone.
  const aCo2 = await req('POST', '/companies', {
    token: A.signupToken,
    json: { name: `Trial Co ${run}-A2`, industry: 'Retail', phone: freshPhone() },
  });
  const aCo2Id = data(aCo2)?.id as string;
  const dupEmailBody = await requestTrialBody(A.signupToken, aCo2Id);
  check('duplicate email (body shape) → 403 TRIAL_EMAIL_USED', dupEmailBody.status === 403 && code(dupEmailBody) === 'TRIAL_EMAIL_USED', dupEmailBody.body);
  const dupEmailHeader = await requestTrialHeader(A.signupToken, aCo2Id);
  check('duplicate email (header shape) → 403 TRIAL_EMAIL_USED', dupEmailHeader.status === 403 && code(dupEmailHeader) === 'TRIAL_EMAIL_USED', dupEmailHeader.body);
  check('message names no company or user', !/Trial Co|trial_/.test(dupEmailBody.body?.error?.message ?? ''), dupEmailBody.body?.error?.message);

  // A different owner whose company phone is A's number, stored in another
  // spelling (00 92 …) straight into the row — normalisation must still match.
  const C = await owner();
  await sql(`UPDATE companies SET phone = $2 WHERE id = $1`, [C.companyId, `0092 ${(A.phone as string).slice(1)}`]);
  const dupPhoneBody = await requestTrialBody(C.signupToken, C.companyId);
  check('duplicate phone in another spelling (body shape) → 403 TRIAL_PHONE_USED', dupPhoneBody.status === 403 && code(dupPhoneBody) === 'TRIAL_PHONE_USED', dupPhoneBody.body);
  const dupPhoneHeader = await requestTrialHeader(C.signupToken, C.companyId);
  check('duplicate phone (header shape) → 403 TRIAL_PHONE_USED', dupPhoneHeader.status === 403 && code(dupPhoneHeader) === 'TRIAL_PHONE_USED', dupPhoneHeader.body);
  const cRow = await companyRow(C.companyId);
  check('a refused request leaves the company untouched', cRow.payment_status === 'none' && cRow.trial_requested_at === null, cRow);

  const foreign = await requestTrialBody(C.signupToken, A.companyId);
  check("naming someone else's company → 403", foreign.status === 403, foreign.body);

  // ── d. Concurrency ──────────────────────────────────────────────────────
  console.log('\n— d. two simultaneous requests, one phone');
  for (let round = 1; round <= 3; round++) {
    const shared = freshPhone();
    const D = await owner({ phone: shared });
    const E = await owner({ phone: freshPhone() });
    await sql(`UPDATE companies SET phone = $2 WHERE id = $1`, [E.companyId, canonical(shared)]);
    const [r1, r2] = await Promise.all([
      requestTrialBody(D.signupToken, D.companyId),
      requestTrialHeader(E.signupToken, E.companyId),
    ]);
    const statuses = [r1.status, r2.status].sort();
    const loser = r1.status === 201 ? r2 : r1;
    check(`round ${round}: exactly one 201 and one 403`, statuses[0] === 201 && statuses[1] === 403, { r1: r1.status, r2: r2.status, b1: r1.body, b2: r2.body });
    check(`round ${round}: the loser gets TRIAL_PHONE_USED, not a 500`, code(loser) === 'TRIAL_PHONE_USED', loser.body);
    const claims = (await sql(
      `SELECT COUNT(*)::int c FROM trial_claims WHERE phone_normalized = $1 AND status <> 'released'`,
      [canonical(shared)],
    ))[0].c;
    const subs = (await sql(
      `SELECT COUNT(*)::int c FROM platform_payment_submissions WHERE kind = 'TRIAL' AND company_id IN ($1, $2)`,
      [D.companyId, E.companyId],
    ))[0].c;
    check(`round ${round}: one claim, one submission`, claims === 1 && subs === 1, { claims, subs });
  }

  // ── e. Registration steps are enforced server-side ──────────────────────
  console.log('\n— e. unverified email, missing or bad phone');
  const F = await owner({ verified: false });
  const fReq = await requestTrialBody(F.signupToken, F.companyId);
  check('unverified email → 403 EMAIL_NOT_VERIFIED', fReq.status === 403 && code(fReq) === 'EMAIL_NOT_VERIFIED', fReq.body);
  const G = await owner({ phone: null });
  const gReq = await requestTrialBody(G.signupToken, G.companyId);
  check('no company phone → 400 TRIAL_PHONE_REQUIRED', gReq.status === 400 && code(gReq) === 'TRIAL_PHONE_REQUIRED', gReq.body);
  await sql(`UPDATE companies SET phone = '12345' WHERE id = $1`, [G.companyId]);
  const gBad = await requestTrialBody(G.signupToken, G.companyId);
  check('unnormalisable phone → 400 TRIAL_PHONE_REQUIRED', gBad.status === 400 && code(gBad) === 'TRIAL_PHONE_REQUIRED', gBad.body);
  const noCompany = await req('POST', '/companies/start-trial', { token: G.signupToken, json: {} });
  check('no company named at all → 400 COMPANY_REQUIRED', noCompany.status === 400 && code(noCompany) === 'COMPANY_REQUIRED', noCompany.body);

  // ── f. Rejection ────────────────────────────────────────────────────────
  console.log('\n— f. reject releases; reject-with-block does not');
  const H = await owner();
  const h1 = data(await requestTrialBody(H.signupToken, H.companyId));
  const hRej = await reject(h1.submissionId);
  check('reject (default) → 200', hRej.status === 200, hRej.body);
  const hRow = await companyRow(H.companyId);
  check('company back to draft, paymentStatus none, trialRequestedAt kept', hRow.status === 'email_verified' && hRow.payment_status === 'none' && hRow.trial_requested_at != null && hRow.is_trial === false, hRow);
  const hClaim = (await sql(`SELECT status FROM trial_claims WHERE submission_id = $1`, [h1.submissionId]))[0];
  check('claim → released', hClaim?.status === 'released', hClaim);
  const hLogin = await signin(H.email);
  check('rejected-trial owner can sign in again (draft)', hLogin.status === 200 && data(hLogin)?.companyStatus === 'draft', hLogin.body);
  const hStatus = data(await req('GET', '/billing/status', { token: data(hLogin)?.tokens?.accessToken, companyId: H.companyId }));
  check('status shows the rejected TRIAL with its reason', hStatus?.lastSubmission?.kind === 'TRIAL' && hStatus?.lastSubmission?.status === 'rejected' && hStatus?.lastSubmission?.rejectionReason === 'QA review' && hStatus?.trialPending === false, hStatus?.lastSubmission);
  const hRejectAgain = await reject(h1.submissionId, true);
  check('a decided request cannot be re-decided (400)', hRejectAgain.status === 400, hRejectAgain.body);

  const h2Res = await requestTrialHeader(H.signupToken, H.companyId);
  const h2 = data(h2Res);
  check('after a released rejection the same email+phone may request again (201)', h2Res.status === 201, h2Res.body);
  const hBlock = await reject(h2.submissionId, true);
  check('reject & block → 200', hBlock.status === 200, hBlock.body);
  const hClaim2 = (await sql(`SELECT status FROM trial_claims WHERE submission_id = $1`, [h2.submissionId]))[0];
  check('claim → blocked', hClaim2?.status === 'blocked', hClaim2);
  const h3 = await requestTrialBody(H.signupToken, H.companyId);
  check('re-request after a block → 403 TRIAL_EMAIL_USED', h3.status === 403 && code(h3) === 'TRIAL_EMAIL_USED', h3.body);
  const I = await owner();
  await sql(`UPDATE companies SET phone = $2 WHERE id = $1`, [I.companyId, canonical(H.phone as string)]);
  const iReq = await requestTrialBody(I.signupToken, I.companyId);
  check('the blocked phone is refused for a different owner too', iReq.status === 403 && code(iReq) === 'TRIAL_PHONE_USED', iReq.body);

  // ── h. Expiry: live cut-off, then trial-worded scan + milestone emails ──
  console.log('\n— h. expiry');
  const K = await owner();
  const kSub = data(await requestTrialBody(K.signupToken, K.companyId));
  await approve(kSub.submissionId);
  const kToken = data(await signin(K.email))?.tokens?.accessToken as string;
  check('trial company K open before expiry', (await req('GET', '/customers', { token: kToken, companyId: K.companyId })).status === 200);

  // Reminder window: 5 days left → in-app trial wording + the 7-day email.
  await sql(
    `UPDATE companies SET subscription_expiry_date = now() + interval '5 days', subscription_reminder_on = NULL WHERE id = $1`,
    [K.companyId],
  );
  await req('POST', '/admin/payment-submissions/run-expiry-scan', { token: superToken });
  let kRow = await companyRow(K.companyId);
  const kReminder = (await sql(
    `SELECT title FROM notifications WHERE company_id = $1 AND type = 'subscription_expiring' ORDER BY created_at DESC LIMIT 1`,
    [K.companyId],
  ))[0];
  check('5 days left → trial-worded reminder', kReminder?.title === 'Free trial ending soon', kReminder);
  check('5 days left → 7-day email milestone recorded, status expiring', kRow.trial_reminder_milestone === 7 && kRow.subscription_status === 'expiring', kRow);
  await sql(`UPDATE companies SET subscription_reminder_on = NULL WHERE id = $1`, [K.companyId]);
  await req('POST', '/admin/payment-submissions/run-expiry-scan', { token: superToken });
  kRow = await companyRow(K.companyId);
  check('same milestone again → no second email (milestone stays 7)', kRow.trial_reminder_milestone === 7, kRow.trial_reminder_milestone);
  await sql(
    `UPDATE companies SET subscription_expiry_date = now() + interval '2 days', subscription_reminder_on = NULL WHERE id = $1`,
    [K.companyId],
  );
  await req('POST', '/admin/payment-submissions/run-expiry-scan', { token: superToken });
  kRow = await companyRow(K.companyId);
  check('2 days left → 3-day milestone', kRow.trial_reminder_milestone === 3, kRow.trial_reminder_milestone);

  // The boundary passes — NO cron run. Access must end on the next request.
  await sql(`UPDATE companies SET subscription_expiry_date = now() - interval '1 second' WHERE id = $1`, [K.companyId]);
  const kLive = await req('GET', '/customers', { token: kToken, companyId: K.companyId });
  check('past expiry, before any scan → CompanyGuard 403 COMPANY_NOT_ACTIVE', kLive.status === 403 && code(kLive) === 'COMPANY_NOT_ACTIVE', kLive.body);
  const kExpiredLogin = await signin(K.email);
  check('expired trial owner can still sign in, renew-only (inactive)', kExpiredLogin.status === 200 && data(kExpiredLogin)?.companyStatus === 'inactive', kExpiredLogin.body);
  await req('POST', '/admin/payment-submissions/run-expiry-scan', { token: superToken });
  kRow = await companyRow(K.companyId);
  const kEnded = (await sql(
    `SELECT title FROM notifications WHERE company_id = $1 AND type = 'subscription_expired' ORDER BY created_at DESC LIMIT 1`,
    [K.companyId],
  ))[0];
  check('scan persists inactive + expired, isTrial kept', kRow.status === 'inactive' && kRow.subscription_status === 'expired' && kRow.is_trial === true, kRow);
  check('scan uses trial wording', kEnded?.title === 'Your free trial has ended', kEnded);
  const kRetry = await requestTrialBody(data(kExpiredLogin)?.tokens?.accessToken, K.companyId);
  check('an expired trial cannot be restarted → TRIAL_ALREADY_USED', kRetry.status === 403 && code(kRetry) === 'TRIAL_ALREADY_USED', kRetry.body);

  // ── i. Subscribing mid-trial ────────────────────────────────────────────
  console.log('\n— i. subscribe during the trial');
  const riderBody = (n: number) => ({
    username: `trial_rider_${run}_${n}`,
    password: PASSWORD,
    name: `Rider ${n}`,
    vehicleType: 'motorcycle',
    maxLoad: 10,
  });
  let riderSeq = 0;
  const addRider = async (token: string, companyId: string) => {
    riderSeq += 1;
    const r = await req('POST', '/delivery-personnel', { token, companyId, json: riderBody(riderSeq) });
    return { res: r, userId: data(r)?.userId as string, username: riderBody(riderSeq).username };
  };
  const r1 = await addRider(aActiveToken, A.companyId);
  check('trial allows its one rider', r1.res.status === 201 || r1.res.status === 200, r1.res.body);
  const r2Fail = await addRider(aActiveToken, A.companyId);
  check('2nd rider on the trial → 400 DELIVERY_PERSONNEL_LIMIT_REACHED (trial wording)', r2Fail.res.status === 400 && code(r2Fail.res) === 'DELIVERY_PERSONNEL_LIMIT_REACHED' && /free trial/i.test(r2Fail.res.body?.error?.message ?? ''), r2Fail.res.body);

  // 20 days of trial left when the owner pays.
  await sql(`UPDATE companies SET subscription_expiry_date = now() + interval '20 days' WHERE id = $1`, [A.companyId]);
  const aPaid = await submitPayment(aActiveToken, A.companyId, 'warehouse_starter_6mo');
  const aPaidBody = data(aPaid);
  check('payment during the trial accepted, labelled NEW', (aPaid.status === 201 || aPaid.status === 200) && aPaidBody?.kind === 'NEW', aPaid.body);
  const aStillOpen = await req('GET', '/customers', { token: aActiveToken, companyId: A.companyId });
  check('trial keeps working while the payment is reviewed', aStillOpen.status === 200, aStillOpen.status);
  const aApprovePaid = await approve(aPaidBody.submissionId ?? aPaidBody.id);
  check('approve the payment → 200', aApprovePaid.status === 200, aApprovePaid.body);
  aRow = await companyRow(A.companyId);
  const paidExpiry = new Date(aRow.subscription_expiry_date).getTime();
  const sixMonths = new Date();
  sixMonths.setMonth(sixMonths.getMonth() + 6);
  check('trial_converted_at set, is_trial still true, plan = paid key', aRow.trial_converted_at != null && aRow.is_trial === true && aRow.subscription_plan === 'warehouse_starter_6mo' && aRow.payment_status === 'paid', aRow);
  check('paid term starts at approval — unused trial days NOT stacked', Math.abs(paidExpiry - sixMonths.getTime()) < 2 * DAY, { expiry: aRow.subscription_expiry_date });
  const aRev = (await sql(`SELECT COUNT(*)::int c FROM platform_revenue WHERE company_id = $1`, [A.companyId]))[0].c;
  check('exactly one revenue row after conversion', aRev === 1, aRev);
  const aStatusPaid = data(await req('GET', '/billing/status', { token: aActiveToken, companyId: A.companyId }));
  check('billing status: converted, no trial countdown', aStatusPaid?.trialConvertedAt != null && aStatusPaid?.trialDaysRemaining === null && aStatusPaid?.isTrial === true, aStatusPaid);
  const aMePaid = data(await req('GET', '/auth/me', { token: aActiveToken }));
  check('/auth/me subscription shows the conversion', aMePaid?.subscription?.trialConvertedAt != null, aMePaid?.subscription);

  // ── k. Rider seats ──────────────────────────────────────────────────────
  console.log('\n— k. rider seats');
  const r2 = await addRider(aActiveToken, A.companyId);
  const r3 = await addRider(aActiveToken, A.companyId);
  check('Starter allows riders 2 and 3', [r2.res.status, r3.res.status].every((s) => s === 201 || s === 200), [r2.res.body, r3.res.body]);
  const r4Fail = await addRider(aActiveToken, A.companyId);
  check('4th rider on Starter refused', r4Fail.res.status === 400, r4Fail.res.status);

  // Scale (10) → add riders 4 and 5.
  const toScale = data(await submitPayment(aActiveToken, A.companyId, 'warehouse_scale_6mo'));
  await approve(toScale.id);
  const r4 = await addRider(aActiveToken, A.companyId);
  const r5 = await addRider(aActiveToken, A.companyId);
  check('Scale allows riders 4 and 5', [r4.res.status, r5.res.status].every((s) => s === 201 || s === 200), [r4.res.body, r5.res.body]);

  // Rider 5 signs in while it still has a seat — this token is used below.
  const r5Login = await signinWith({ identifier: r5.username, password: PASSWORD });
  const r5Token = data(r5Login)?.tokens?.accessToken as string;
  check('rider 5 signs in while seated', r5Login.status === 200 && !!r5Token, r5Login.body);

  // Downgrade back to Starter (3): the two newest riders are paused.
  const toStarter = data(await submitPayment(aActiveToken, A.companyId, 'warehouse_starter_6mo'));
  await approve(toStarter.id);
  const seats = await sql(
    `SELECT user_id, status FROM delivery_personnel_profiles WHERE company_id = $1`,
    [A.companyId],
  );
  const statusOf = (id: string) => seats.find((s: any) => s.user_id === id)?.status;
  check(
    'downgrade locks exactly the two newest riders',
    statusOf(r1.userId) === 'active' && statusOf(r2.userId) === 'active' && statusOf(r3.userId) === 'active' &&
      statusOf(r4.userId) === 'plan_locked' && statusOf(r5.userId) === 'plan_locked',
    seats,
  );
  const limits = data(await req('GET', '/billing/plan-limits', { token: aActiveToken, companyId: A.companyId }));
  check('plan-limits reports 3 active, 2 locked', limits?.currentCount === 3 && limits?.lockedCount === 2, limits);
  const lockedNote = (await sql(
    `SELECT COUNT(*)::int c FROM notifications WHERE company_id = $1 AND type = 'personnel_plan_locked'`,
    [A.companyId],
  ))[0].c;
  check('owner notified that riders were paused', lockedNote >= 1, lockedNote);

  const r5LockedLogin = await signinWith({ identifier: r5.username, password: PASSWORD });
  check('locked rider sign-in → 403 RIDER_SEAT_LOCKED', r5LockedLogin.status === 403 && code(r5LockedLogin) === 'RIDER_SEAT_LOCKED', r5LockedLogin.body);
  const r5Live = await req('GET', '/deliveries', { token: r5Token, companyId: A.companyId });
  check("locked rider's existing token is refused live by CompanyGuard", r5Live.status === 403 && code(r5Live) === 'RIDER_SEAT_LOCKED', r5Live.body);
  const assignLocked = await req('POST', '/deliveries/assign', {
    token: aActiveToken,
    companyId: A.companyId,
    json: { deliveryIds: [randomUUID()], personnelId: r5.userId },
  });
  check('assigning work to a locked rider → 400 RIDER_NOT_ACTIVE', assignLocked.status === 400 && code(assignLocked) === 'RIDER_NOT_ACTIVE', assignLocked.body);
  const reactivate = await req('PATCH', `/delivery-personnel/${r5.userId}`, {
    token: aActiveToken,
    companyId: A.companyId,
    json: { status: 'active' },
  });
  check('reactivating a locked rider with no free seat → 400 LIMIT_REACHED', reactivate.status === 400 && code(reactivate) === 'DELIVERY_PERSONNEL_LIMIT_REACHED', reactivate.body);
  const setLocked = await req('PATCH', `/delivery-personnel/${r1.userId}`, {
    token: aActiveToken,
    companyId: A.companyId,
    json: { status: 'plan_locked' },
  });
  check('owner cannot set plan_locked by hand (400)', setLocked.status === 400, setLocked.body);

  // Swap: pause rider 1 by choice, give the seat to rider 5.
  const deactivate = await req('PATCH', `/delivery-personnel/${r1.userId}`, {
    token: aActiveToken,
    companyId: A.companyId,
    json: { status: 'inactive' },
  });
  const swapIn = await req('PATCH', `/delivery-personnel/${r5.userId}`, {
    token: aActiveToken,
    companyId: A.companyId,
    json: { status: 'active' },
  });
  check('swap: deactivate one, activate a locked one', deactivate.status === 200 && swapIn.status === 200, [deactivate.body, swapIn.body]);
  const r5Back = await signinWith({ identifier: r5.username, password: PASSWORD });
  check('swapped-in rider signs in again', r5Back.status === 200, r5Back.body);

  // Upgrade to Growth (5): the remaining locked rider is restored; the rider
  // the owner deactivated stays inactive.
  const toGrowth = data(await submitPayment(aActiveToken, A.companyId, 'warehouse_growth_6mo'));
  await approve(toGrowth.id);
  const seats2 = await sql(`SELECT user_id, status FROM delivery_personnel_profiles WHERE company_id = $1`, [A.companyId]);
  const statusOf2 = (id: string) => seats2.find((s: any) => s.user_id === id)?.status;
  check(
    'upgrade restores locked riders; owner-deactivated rider untouched',
    statusOf2(r4.userId) === 'active' && statusOf2(r5.userId) === 'active' && statusOf2(r1.userId) === 'inactive' &&
      seats2.filter((s: any) => s.status === 'plan_locked').length === 0,
    seats2,
  );

  // ── Ledger isolation ────────────────────────────────────────────────────
  const touchedLedger = (await sql(
    `SELECT COUNT(*)::int c FROM journal_entries WHERE company_id = ANY($1)`,
    [[K.companyId, H.companyId]],
  ))[0].c;
  check('trial lifecycle wrote nothing to journal_entries', touchedLedger === 0, touchedLedger);

  await pg.end();

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
  if (fail) console.log('FAILED:', fails.join(' | '));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
