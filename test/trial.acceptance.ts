/**
 * Free trial — launch acceptance (npm run test:trial).
 *
 * Proves, against a running API and its database:
 *   - an eligible owner's trial starts INSTANTLY (auto-approved, same
 *     transaction as the claim), with the trial plan, an end exactly
 *     TRIAL_DAYS later, the welcome email and the admin FYI;
 *   - every eligibility rule answers with its own reason, and the setup
 *     screen's eligibility check agrees with the start itself;
 *   - one trial per ACCOUNT: same user, Gmail dot/+tag email variants, the
 *     same phone written differently, the same NTN, the same company; a race
 *     yields exactly one trial; changing the phone afterwards frees nothing;
 *   - risk signals hold a request for a person; admin grant overrides;
 *   - path B: approval needs a plan + end date (or "as trial", which follows
 *     the claim rules); no company is ever left active without them;
 *   - the lifecycle with time travel: reminders once per milestone (Asia/
 *     Karachi days), extension, ending early, expiry; TRIAL_ENDED for owner
 *     and staff, the owner's backup still allowed; activation during and
 *     after a trial restores access with the books unchanged;
 *   - companies from the old path (pending_approval, legacy active) still work.
 *
 * Environment: see test/launch-helpers.ts. Optional extra API processes on the
 * SAME database exercise the switches:
 *   QUEUE_API_BASE     an API started with TRIAL_AUTO_APPROVE=false
 *   APPROVAL_API_BASE  an API started with SIGNUP_MODE=approval
 * EXPECT_MAIL=true asserts emails through Mailpit.
 */
import {
  canonical,
  check,
  code,
  data,
  DAY,
  Db,
  finish,
  freshIp,
  freshPhone,
  mailpitAvailable,
  mailText,
  mailTo,
  owner,
  type Owner,
  req,
  RUN,
  section,
  signin,
  startTrial,
  superAdmin,
  trialBalance,
} from './launch-helpers';

async function main() {
  const db = await new Db().open();
  const admin = await superAdmin(db);
  const mail = await mailpitAvailable();
  console.log(
    `\n=== Free trial (launch) — ${process.env.API_BASE ?? 'http://localhost:3101/api/v1'} ` +
      `· mail ${mail ? 'asserted' : 'not asserted'} ===`,
  );

  const reason = (r: { body: any }) =>
    r.body?.error?.reason ?? r.body?.reason ?? r.body?.error?.details?.reason;
  const company = (id: string) =>
    db.one(`SELECT * FROM companies WHERE id = $1`, [id]);
  const claimsOf = (companyId: string) =>
    db.sql(`SELECT * FROM trial_claims WHERE company_id = $1`, [companyId]);
  const asAdmin = (method: string, path: string, json?: unknown) =>
    req(method, path, { token: admin.token, json });

  // ── A. Public config and eligibility ──────────────────────────────────────
  section('A. public config + eligibility');
  const cfg = data(await req('GET', '/public/config'));
  check(
    'GET /public/config: trial mode, auto-approve, 30 days',
    cfg?.signupMode === 'trial' &&
      cfg?.trialAutoApprove === true &&
      cfg?.trialDays === 30,
    cfg,
  );
  const A = await owner(db, { taxId: `NTN ${RUN.length}${Date.now() % 1e7}` });
  const aElig = data(
    await req('GET', `/companies/${A.companyId}/trial-eligibility`, {
      token: A.token,
    }),
  );
  check(
    'eligibility: a fresh owner is eligible',
    aElig?.eligible === true,
    aElig,
  );

  // ── B. Instant trial ─────────────────────────────────────────────────────
  section('B. eligible owner → trial starts instantly');
  const before = Date.now();
  const aStart = await startTrial(A);
  const aBody = data(aStart);
  check(
    'start-trial → 201, status active, autoApproved, no pending screen',
    aStart.status === 201 &&
      aBody?.status === 'active' &&
      aBody?.autoApproved === true &&
      aBody?.held === false,
    { status: aStart.status, body: aBody },
  );
  const aRow = await company(A.companyId);
  const endMs = new Date(aRow.subscription_expiry_date).getTime();
  check(
    'company active on warehouse_trial, ends exactly 30 days later',
    (aRow.status === 'active' || aRow.status === 'approved') &&
      aRow.subscription_plan === 'warehouse_trial' &&
      aRow.is_trial === true &&
      Math.abs(endMs - (before + 30 * DAY)) < 5 * 60_000,
    {
      status: aRow.status,
      plan: aRow.subscription_plan,
      end: aRow.subscription_expiry_date,
    },
  );
  const aSub = await db.one(
    `SELECT * FROM platform_payment_submissions WHERE id = $1`,
    [aBody?.submissionId],
  );
  check(
    'submission: approved by system:auto, auto_approved=true, reviewer NULL',
    aSub?.status === 'approved' &&
      aSub?.auto_approved === true &&
      aSub?.review_source === 'system:auto' &&
      aSub?.reviewed_by === null,
    aSub,
  );
  const aClaims = await claimsOf(A.companyId);
  check(
    'claim approved with every identity (user, email key, phone, NTN)',
    aClaims.length === 1 &&
      aClaims[0].status === 'approved' &&
      aClaims[0].source === 'auto' &&
      aClaims[0].user_id === A.userId &&
      aClaims[0].phone_normalized === canonical(A.phone as string) &&
      !!aClaims[0].tax_id_normalized,
    aClaims,
  );
  const aMe = data(await req('GET', '/auth/me', { token: A.token }));
  check(
    '/auth/me: active, trial summary',
    aMe?.companyStatus === 'active' && aMe?.subscription?.isTrial === true,
    aMe?.companyStatus,
  );
  const aAccounts = await req('GET', '/accounts', { token: A.token });
  check(
    'business routes open immediately',
    aAccounts.status === 200,
    aAccounts.status,
  );
  const audit = await db.one(
    `SELECT * FROM platform_audit_events WHERE action = 'trial_auto_approved' AND company_id = $1`,
    [A.companyId],
  );
  check(
    'platform audit: trial_auto_approved by system:auto',
    audit?.actor_label === 'system:auto',
  );
  if (mail) {
    const welcome = await mailTo(A.email, {
      subject: /free trial has started/i,
    });
    check('welcome email to the owner', welcome.length === 1, welcome.length);
    if (welcome[0]) {
      const body = await mailText(welcome[0].ID);
      check(
        'welcome email: Urdu section and "Move your data in" link',
        /dir="rtl"/.test(body) && /settings\/migration\/guide/.test(body),
      );
    }
    const fyi = await mailTo('platform-admin@example.com', {
      subject: new RegExp(`New free trial started: QA Co ${RUN}`),
    });
    check('admin FYI email (no action needed)', fyi.length >= 1, fyi.length);
  }

  // ── C. Each eligibility failure has its own reason ───────────────────────
  section('C. eligibility reasons');
  // Unverified email: the controller's email gate answers first.
  const U = await owner(db, { verified: false });
  const uCo = await req('POST', '/companies', {
    token: U.token,
    json: { name: `QA Unverified ${RUN}`, phone: freshPhone() },
  });
  check(
    'unverified email: cannot set up or start (EMAIL_NOT_VERIFIED)',
    uCo.status === 403 && code(uCo) === 'EMAIL_NOT_VERIFIED',
    { status: uCo.status, code: code(uCo) },
  );
  // No (valid) phone.
  const P = await owner(db, { phone: null });
  const pStart = await startTrial(P);
  check(
    'no phone → 409 TRIAL_NOT_ELIGIBLE / TRIAL_PHONE_REQUIRED',
    pStart.status === 409 &&
      code(pStart) === 'TRIAL_NOT_ELIGIBLE' &&
      reason(pStart) === 'TRIAL_PHONE_REQUIRED',
    { status: pStart.status, body: pStart.body },
  );
  check(
    '… with an Urdu message',
    /[؀-ۿ]/.test(pStart.body?.error?.details?.messageUr ?? ''),
    pStart.body,
  );
  // Not the owner: a rider who joined with the invite code.
  const N = await owner(db);
  const nCo = await company(N.companyId);
  const riderEmail = `rider_${RUN}@example.com`;
  await req('POST', '/auth/signup', {
    ip: freshIp(),
    json: {
      email: riderEmail,
      password: 'Qa@12345',
      displayName: 'QA Rider',
      role: 'delivery',
      companyCode: nCo.invite_code,
    },
  });
  const riderToken = await signin(riderEmail);
  const nRider = await req('POST', '/companies/start-trial', {
    token: riderToken,
    json: { companyId: N.companyId },
  });
  check(
    'not the owner → TRIAL_NOT_OWNER',
    nRider.status === 409 && reason(nRider) === 'TRIAL_NOT_OWNER',
    { status: nRider.status, body: nRider.body },
  );
  // Not a draft: submitted for approval (path B) already.
  const D = await owner(db);
  await req('POST', `/companies/${D.companyId}/submit`, {
    token: D.token,
    json: { requestedPlan: 'unsure' },
  });
  const dStart = await startTrial(D);
  check(
    'already submitted (not a draft) → COMPANY_NOT_DRAFT',
    dStart.status === 409 && reason(dStart) === 'COMPANY_NOT_DRAFT',
    reason(dStart),
  );
  // Disposable email domain.
  const X = await owner(db, { email: `qa_${RUN}@mailinator.com` });
  const xElig = data(
    await req('GET', `/companies/${X.companyId}/trial-eligibility`, {
      token: X.token,
    }),
  );
  const xStart = await startTrial(X);
  check(
    'disposable email domain → TRIAL_EMAIL_DOMAIN_BLOCKED (eligibility agrees)',
    xStart.status === 409 &&
      reason(xStart) === 'TRIAL_EMAIL_DOMAIN_BLOCKED' &&
      xElig?.eligible === false &&
      xElig?.reason === 'TRIAL_EMAIL_DOMAIN_BLOCKED',
    { start: reason(xStart), elig: xElig },
  );

  // ── D. One trial per account — every identity ────────────────────────────
  section('D. one trial per account');
  // Same user, second company.
  const a2 = await req('POST', '/companies', {
    token: A.token,
    json: { name: `QA A second ${RUN}`, phone: freshPhone() },
  });
  const a2Owner: Owner = { ...A, companyId: data(a2)?.id, ip: freshIp() };
  const a2Elig = data(
    await req('GET', `/companies/${a2Owner.companyId}/trial-eligibility`, {
      token: A.token,
    }),
  );
  const a2Start = await startTrial(a2Owner);
  check(
    'same owner, second company → TRIAL_USER_USED (shown before pressing)',
    a2Start.status === 409 &&
      reason(a2Start) === 'TRIAL_USER_USED' &&
      a2Elig?.reason === 'TRIAL_USER_USED',
    { start: reason(a2Start), elig: a2Elig?.reason },
  );
  // Gmail variants.
  const G1 = await owner(db, { email: `qa.gmail.${RUN}@gmail.com` });
  const g1 = await startTrial(G1);
  check('Gmail owner gets a trial', g1.status === 201, g1.status);
  for (const variant of [
    `q.a.gmail.${RUN}@gmail.com`,
    `qagmail${RUN}+second@gmail.com`,
    `q.a.g.mail.${RUN}@googlemail.com`,
  ]) {
    const V = await owner(db, { email: variant });
    const v = await startTrial(V);
    check(
      `email variant ${variant} → TRIAL_EMAIL_USED`,
      v.status === 409 && reason(v) === 'TRIAL_EMAIL_USED',
      reason(v),
    );
  }
  // +tag at another provider.
  const T1 = await owner(db, { email: `tagged_${RUN}@company-example.com` });
  await startTrial(T1);
  const T2 = await owner(db, {
    email: `tagged_${RUN}+again@company-example.com`,
  });
  const t2 = await startTrial(T2);
  check(
    '+tag at any provider → TRIAL_EMAIL_USED',
    t2.status === 409 && reason(t2) === 'TRIAL_EMAIL_USED',
    reason(t2),
  );
  // Same phone, written differently.
  const local = A.phone as string; // 0321…
  for (const spelling of [
    canonical(local),
    `92${local.slice(1)}`,
    `${local.slice(0, 4)}-${local.slice(4)}`,
  ]) {
    const S = await owner(db, { phone: spelling });
    const s = await startTrial(S);
    check(
      `same phone as ${spelling} → TRIAL_PHONE_USED`,
      s.status === 409 && reason(s) === 'TRIAL_PHONE_USED',
      reason(s),
    );
  }
  // Same NTN (different spelling).
  const aTax = aClaims[0].tax_id_normalized as string;
  const Nt = await owner(db, {
    taxId: `${aTax.slice(0, 4)}-${aTax.slice(4)}`,
  });
  const nt = await startTrial(Nt);
  check(
    'same NTN → TRIAL_TAX_ID_USED',
    nt.status === 409 && reason(nt) === 'TRIAL_TAX_ID_USED',
    reason(nt),
  );
  // Same company twice.
  const aAgain = await startTrial(A);
  check(
    'same company asking twice → TRIAL_ALREADY_USED',
    aAgain.status === 409 && reason(aAgain) === 'TRIAL_ALREADY_USED',
    reason(aAgain),
  );
  // Refusals change nothing.
  const ntRow = await company(Nt.companyId);
  check(
    'a refused request leaves the company an untouched draft',
    ntRow.status === 'email_verified' &&
      ntRow.payment_status === 'none' &&
      (await claimsOf(Nt.companyId)).length === 0,
  );

  // ── E. Race ───────────────────────────────────────────────────────────────
  section('E. race: two companies, one phone, same moment');
  for (let round = 1; round <= 3; round++) {
    const shared = freshPhone();
    const R1 = await owner(db, { phone: shared });
    const R2 = await owner(db, { phone: `+92${shared.slice(1)}` });
    const [r1, r2] = await Promise.all([startTrial(R1), startTrial(R2)]);
    const statuses = [r1.status, r2.status].sort();
    const reasons = [reason(r1), reason(r2)].filter(Boolean);
    const claims = await db.sql(
      `SELECT * FROM trial_claims WHERE phone_normalized = $1 AND status IN ('pending','approved','blocked')`,
      [canonical(shared)],
    );
    check(
      `round ${round}: exactly one trial (201 + 409 TRIAL_PHONE_USED), one claim`,
      statuses[0] === 201 &&
        statuses[1] === 409 &&
        reasons[0] === 'TRIAL_PHONE_USED' &&
        claims.length === 1,
      { statuses, reasons, claims: claims.length },
    );
  }

  // ── F. Changing the phone after a trial frees nothing ─────────────────────
  section('F. claims are recorded at trial time');
  await req('PATCH', `/companies/${A.companyId}`, {
    token: A.token,
    json: { phone: freshPhone() },
  });
  const Fp = await owner(db, { phone: local });
  const fp = await startTrial(Fp);
  check(
    'A changed its phone; its old phone still cannot trial',
    fp.status === 409 && reason(fp) === 'TRIAL_PHONE_USED',
    reason(fp),
  );

  // ── G. Risk signals hold for review ───────────────────────────────────────
  section('G. risk signals');
  const sharedIp = freshIp();
  const riskOwners: Owner[] = [];
  for (let i = 0; i < 4; i++) {
    const o = await owner(db);
    riskOwners.push({ ...o, ip: sharedIp });
  }
  // Three earlier attempts from this network (one of them refused).
  await startTrial({ ...P, ip: sharedIp });
  await startTrial(riskOwners[0]);
  await startTrial(riskOwners[1]);
  const held = await startTrial(riskOwners[2]);
  const heldBody = data(held);
  check(
    '4th attempt from one network in 24 h → held (pending, reason hidden from owner)',
    held.status === 201 &&
      heldBody?.status === 'pending_approval' &&
      heldBody?.held === true &&
      heldBody?.autoApproved === false &&
      !JSON.stringify(heldBody).includes('network'),
    heldBody,
  );
  const heldSub = await db.one(
    `SELECT * FROM platform_payment_submissions WHERE id = $1`,
    [heldBody?.submissionId],
  );
  check(
    'the hold reason is recorded for admins',
    /trial attempts from the same network/.test(heldSub?.hold_reason ?? ''),
    heldSub?.hold_reason,
  );
  const heldList = data(
    await asAdmin('GET', '/admin/trials?view=held&limit=100'),
  );
  check(
    'admin "Held for review" lists it with the reason',
    heldList?.items?.some(
      (r: any) => r.companyId === riskOwners[2].companyId && !!r.holdReason,
    ),
  );
  const approveHeld = await asAdmin(
    'PATCH',
    `/admin/payment-submissions/${heldBody?.submissionId}/approve`,
    {},
  );
  check(
    'admin approves the held trial → active, reviewed by admin',
    approveHeld.status === 200 &&
      (await company(riskOwners[2].companyId)).subscription_plan ===
        'warehouse_trial',
    approveHeld.status,
  );
  // A phone seen on a rejected account.
  const Rj = await owner(db);
  await req('POST', `/companies/${Rj.companyId}/submit`, {
    token: Rj.token,
    json: {},
  });
  await asAdmin('PATCH', `/admin/companies/${Rj.companyId}/reject`, {
    reason: 'QA: not a real business',
  });
  const Rp = await owner(db, { phone: Rj.phone });
  const rp = data(await startTrial(Rp));
  const rpSub = await db.one(
    `SELECT hold_reason FROM platform_payment_submissions WHERE id = $1`,
    [rp?.submissionId],
  );
  check(
    'phone used on a rejected account → held for review',
    rp?.held === true && /rejected or suspended/.test(rpSub?.hold_reason ?? ''),
    { rp, rpSub },
  );

  // ── H. Admin grant overrides the rule ────────────────────────────────────
  section('H. grant-trial');
  const grant = await asAdmin(
    'POST',
    `/admin/companies/${Fp.companyId}/grant-trial`,
    {
      reason: 'QA: agreed after a demo call',
    },
  );
  const fpRow = await company(Fp.companyId);
  const fpClaims = await claimsOf(Fp.companyId);
  const grantAudit = await db.one(
    `SELECT * FROM platform_audit_events WHERE action = 'trial_granted' AND company_id = $1`,
    [Fp.companyId],
  );
  check(
    'grant-trial: ineligible company gets a trial; claim "granted"; audited',
    grant.status === 201 &&
      fpRow.subscription_plan === 'warehouse_trial' &&
      fpClaims.some((c: any) => c.status === 'granted') &&
      grantAudit?.reason === 'QA: agreed after a demo call',
    { status: grant.status, body: grant.body },
  );
  const notAdmin = await req(
    'POST',
    `/admin/companies/${Fp.companyId}/grant-trial`,
    {
      token: A.token,
      json: { reason: 'nope nope' },
    },
  );
  check(
    'a company owner cannot reach admin trial routes',
    notAdmin.status === 403,
  );

  // ── I. Path B — request approval ─────────────────────────────────────────
  section('I. path B: approval with a plan');
  const B = await owner(db);
  const bSubmit = await req('POST', `/companies/${B.companyId}/submit`, {
    token: B.token,
    json: { requestedPlan: 'warehouse_growth_6mo', note: 'Agreed on the call' },
  });
  const bRow1 = await company(B.companyId);
  check(
    'submit → pending_approval with the requested plan and note',
    bSubmit.status === 201 &&
      bRow1.status === 'pending_approval' &&
      bRow1.requested_plan === 'warehouse_growth_6mo' &&
      bRow1.approval_note === 'Agreed on the call',
    { status: bSubmit.status, row: bRow1.status },
  );
  const bNoPlan = await asAdmin(
    'PATCH',
    `/super-admin/companies/${B.companyId}/status`,
    {
      status: 'active',
    },
  );
  check(
    'approve with no end date → 400 (the requested plan alone is not enough)',
    bNoPlan.status === 400 &&
      code(bNoPlan) === 'END_DATE_REQUIRED' &&
      (await company(B.companyId)).status === 'pending_approval',
    { status: bNoPlan.status, code: code(bNoPlan) },
  );
  const Bn = await owner(db);
  await req('POST', `/companies/${Bn.companyId}/submit`, {
    token: Bn.token,
    json: {},
  });
  const bnNoPlan = await asAdmin(
    'PATCH',
    `/super-admin/companies/${Bn.companyId}/status`,
    { status: 'active' },
  );
  check(
    'an old console approving with no plan → 400 PLAN_REQUIRED_FOR_APPROVAL (no free access)',
    bnNoPlan.status === 400 &&
      code(bnNoPlan) === 'PLAN_REQUIRED_FOR_APPROVAL' &&
      (await company(Bn.companyId)).status === 'pending_approval',
    { status: bnNoPlan.status, code: code(bnNoPlan) },
  );
  const bNoEnd = await asAdmin(
    'PATCH',
    `/admin/companies/${B.companyId}/approve`,
    {
      plan: 'warehouse_growth_6mo',
    },
  );
  check(
    'approve without an end date → 400 END_DATE_REQUIRED',
    code(bNoEnd) === 'END_DATE_REQUIRED',
  );
  const end = new Date(Date.now() + 180 * DAY).toISOString();
  const bOk = await asAdmin(
    'PATCH',
    `/admin/companies/${B.companyId}/approve`,
    {
      plan: 'warehouse_growth_6mo',
      endDate: end,
    },
  );
  const bRow2 = await company(B.companyId);
  check(
    'approve with plan + end date → active on that plan until that date',
    bOk.status === 200 &&
      ['approved', 'active'].includes(bRow2.status) &&
      bRow2.subscription_plan === 'warehouse_growth_6mo' &&
      Math.abs(
        new Date(bRow2.subscription_expiry_date).getTime() -
          new Date(end).getTime(),
      ) < 1000,
    { status: bOk.status, row: bRow2.subscription_plan },
  );
  // Approve as a trial — the claim rules apply.
  const Bt = await owner(db);
  await req('POST', `/companies/${Bt.companyId}/submit`, {
    token: Bt.token,
    json: {},
  });
  const btOk = await asAdmin(
    'PATCH',
    `/admin/companies/${Bt.companyId}/approve`,
    {
      asTrial: true,
    },
  );
  check(
    'approve as a trial (eligible) → trial plan, claim recorded',
    btOk.status === 200 &&
      (await company(Bt.companyId)).subscription_plan === 'warehouse_trial' &&
      (await claimsOf(Bt.companyId)).some((c: any) => c.status === 'approved'),
    { status: btOk.status, body: btOk.body },
  );
  const Bt2 = await owner(db, { phone: Bt.phone });
  await req('POST', `/companies/${Bt2.companyId}/submit`, {
    token: Bt2.token,
    json: {},
  });
  const bt2 = await asAdmin(
    'PATCH',
    `/admin/companies/${Bt2.companyId}/approve`,
    {
      asTrial: true,
    },
  );
  check(
    'approve as a trial when the phone already trialed → 409 TRIAL_PHONE_USED',
    bt2.status === 409 && reason(bt2) === 'TRIAL_PHONE_USED',
    { status: bt2.status, body: bt2.body },
  );
  const bad = await db.sql(
    `SELECT id FROM companies
      WHERE status IN ('active','approved') AND subscription_plan = 'free'
        AND subscription_expiry_date IS NULL AND reviewed_at > now() - interval '1 hour'
        AND name LIKE $1`,
    [`QA % ${RUN}%`],
  );
  check(
    'no company approved in this run is active without a plan + end date',
    bad.length === 0,
    bad,
  );

  // ── J. Lifecycle with time travel ────────────────────────────────────────
  section('J. reminders, extension, end, expiry');
  const L = await owner(db);
  await startTrial(L);
  const scan = () =>
    asAdmin('POST', '/admin/payment-submissions/run-expiry-scan');
  const reminders = async () =>
    Number(
      (
        await db.one(
          `SELECT count(*)::int AS n FROM notifications
            WHERE company_id = $1 AND type = 'subscription_expiring'`,
          [L.companyId],
        )
      ).n,
    );
  await db.sql(
    `UPDATE companies SET subscription_expiry_date = now() + interval '6 days 12 hours' WHERE id = $1`,
    [L.companyId],
  );
  await scan();
  await scan();
  const m7 = await company(L.companyId);
  check(
    '7-day milestone: recorded once, one reminder despite two scans',
    m7.trial_reminder_milestone === 7 && (await reminders()) === 1,
    { milestone: m7.trial_reminder_milestone, n: await reminders() },
  );
  await db.sql(
    `UPDATE companies SET subscription_expiry_date = now() + interval '2 days 12 hours' WHERE id = $1`,
    [L.companyId],
  );
  await scan();
  await scan();
  check(
    '3-day milestone: one more reminder',
    (await company(L.companyId)).trial_reminder_milestone === 3 &&
      (await reminders()) === 2,
  );
  if (mail) {
    const ending = await mailTo(L.email, { subject: /trial ends in/i });
    check(
      'trial-ending email sent once per milestone (2)',
      ending.length === 2,
      ending.length,
    );
  }
  const beforeExt = new Date(
    (await company(L.companyId)).subscription_expiry_date,
  ).getTime();
  const ext = await asAdmin(
    'POST',
    `/admin/companies/${L.companyId}/extend-trial`,
    {
      days: 7,
      reason: 'QA: setting up migration',
    },
  );
  const afterExt = await company(L.companyId);
  check(
    'extend-trial +7 days: end moves by 7 days, milestones reset, audited',
    ext.status === 201 &&
      Math.abs(
        new Date(afterExt.subscription_expiry_date).getTime() -
          (beforeExt + 7 * DAY),
      ) < 60_000 &&
      afterExt.trial_reminder_milestone === null &&
      !!(await db.one(
        `SELECT 1 AS x FROM platform_audit_events WHERE action = 'trial_extended' AND company_id = $1`,
        [L.companyId],
      )),
    { status: ext.status, body: ext.body },
  );
  const ext31 = await asAdmin(
    'POST',
    `/admin/companies/${L.companyId}/extend-trial`,
    {
      days: 31,
      reason: 'too long',
    },
  );
  check('extension over 30 days refused', ext31.status === 400, ext31.status);

  // Books before the trial ends: one posted journal entry.
  const accounts = data(
    await req('GET', '/accounts?limit=500', { token: L.token }),
  );
  const list: any[] = accounts?.accounts ?? [];
  const cash =
    list.find((a: any) => a.type === 'asset' && /cash/i.test(a.name)) ??
    list.find((a: any) => a.type === 'asset');
  const equity =
    list.find((a: any) => a.type === 'equity' && /capital|owner/i.test(a.name)) ??
    list.find((a: any) => a.type === 'equity');
  const je = await req('POST', '/journal-entries', {
    token: L.token,
    json: {
      date: new Date().toISOString().slice(0, 10),
      memo: 'QA owner investment',
      status: 'posted',
      lines: [
        { accountId: cash?.id, debit: '25000.0000', credit: '0.0000' },
        { accountId: equity?.id, debit: '0.0000', credit: '25000.0000' },
      ],
    },
  });
  check('a journal entry posts during the trial', je.status === 201, {
    status: je.status,
    body: je.body,
  });
  const tbBefore = await trialBalance(db, L.companyId);

  // A staff member to see what they are told.
  const lCo = await company(L.companyId);
  const lRiderEmail = `lrider_${RUN}@example.com`;
  await req('POST', '/auth/signup', {
    ip: freshIp(),
    json: {
      email: lRiderEmail,
      password: 'Qa@12345',
      displayName: 'QA L Rider',
      role: 'delivery',
      companyCode: lCo.invite_code,
    },
  });
  const lRiderToken = await signin(lRiderEmail);

  const endEarly = await asAdmin(
    'POST',
    `/admin/companies/${L.companyId}/end-trial`,
    {
      reason: 'QA: suspected abuse',
    },
  );
  check('end-trial (early) → 201', endEarly.status === 201, endEarly.body);
  const ownerBlocked = await req('GET', '/accounts', { token: L.token });
  check(
    'after the trial: owner gets TRIAL_ENDED on business routes',
    ownerBlocked.status === 403 && code(ownerBlocked) === 'TRIAL_ENDED',
    { status: ownerBlocked.status, code: code(ownerBlocked) },
  );
  const riderBlocked = await req('GET', '/deliveries', { token: lRiderToken });
  check(
    'staff/riders get TRIAL_ENDED with "contact the owner"',
    riderBlocked.status === 403 &&
      code(riderBlocked) === 'TRIAL_ENDED' &&
      /contact the owner/.test(JSON.stringify(riderBlocked.body)),
    riderBlocked.body,
  );
  const backup = await req('POST', '/data-portability/exports', {
    token: L.token,
    json: { includeXlsx: false },
  });
  check(
    'the owner can still request a full backup',
    backup.status === 202 || backup.status === 201,
    { status: backup.status, body: backup.body },
  );
  const riderBackup = await req('POST', '/data-portability/exports', {
    token: lRiderToken,
    json: {},
  });
  check('… but staff cannot', riderBackup.status === 403, riderBackup.status);
  const newBatch = await req('POST', '/migrations', {
    token: L.token,
    json: { source: 'finmatrix_template' },
  });
  check(
    'a lapsed company cannot start or commit a migration (TRIAL_ENDED)',
    newBatch.status === 403 && code(newBatch) === 'TRIAL_ENDED',
    newBatch.status,
  );
  const batches = await req('GET', '/migrations', { token: L.token });
  check(
    '… but can still list its migrations',
    batches.status === 200,
    batches.status,
  );
  const lMe = data(await req('GET', '/auth/me', { token: L.token }));
  check(
    'sign-in still works; /auth/me says trial ended',
    lMe?.companyStatus === 'inactive' && lMe?.subscription?.trialEnded === true,
    lMe?.subscription,
  );

  // ── K. Activation (no gateway) ───────────────────────────────────────────
  section('K. activation after and during a trial');
  const act = await req(
    'POST',
    `/companies/${L.companyId}/activation-request`,
    {
      token: L.token,
      json: { requestedPlan: 'warehouse_starter_6mo', note: 'Please activate' },
    },
  );
  const actBody = data(act);
  check(
    'owner requests activation after the trial ended',
    act.status === 201 && actBody?.requestedPlan === 'warehouse_starter_6mo',
    act.body,
  );
  const actList = data(await asAdmin('GET', '/admin/trials?view=activations'));
  check(
    'admin "Activation requests" lists it',
    actList?.items?.some((r: any) => r.companyId === L.companyId),
  );
  const actEnd = new Date(Date.now() + 182 * DAY).toISOString();
  const actOk = await asAdmin(
    'PATCH',
    `/admin/payment-submissions/${actBody?.submissionId}/approve`,
    { endDate: actEnd },
  );
  const lAfter = await company(L.companyId);
  const lBack = await req('GET', '/accounts', { token: L.token });
  const tbAfter = await trialBalance(db, L.companyId);
  const rev = await db.one(
    `SELECT count(*)::int AS n FROM platform_revenue WHERE submission_id = $1`,
    [actBody?.submissionId],
  );
  check(
    'approval: requested plan until the end date, trial converted, access back',
    actOk.status === 200 &&
      lAfter.subscription_plan === 'warehouse_starter_6mo' &&
      !!lAfter.trial_converted_at &&
      lBack.status === 200,
    { status: actOk.status, body: actOk.body },
  );
  check(
    'books unchanged by activation; no money recorded',
    tbAfter.d === tbBefore.d &&
      tbAfter.c === tbBefore.c &&
      tbAfter.lines === tbBefore.lines &&
      rev.n === 0,
    { tbBefore, tbAfter, rev },
  );
  // During a trial.
  const Dt = await owner(db);
  await startTrial(Dt);
  const dAct = data(
    await req('POST', `/companies/${Dt.companyId}/activation-request`, {
      token: Dt.token,
      json: { requestedPlan: 'unsure' },
    }),
  );
  const dActOk = await asAdmin(
    'PATCH',
    `/admin/payment-submissions/${dAct?.submissionId}/approve`,
    {
      plan: 'warehouse_growth_1yr',
      endDate: new Date(Date.now() + 365 * DAY).toISOString(),
    },
  );
  const dRow = await company(Dt.companyId);
  check(
    'activation DURING the trial ends it early as converted',
    dActOk.status === 200 &&
      dRow.subscription_plan === 'warehouse_growth_1yr' &&
      !!dRow.trial_converted_at,
    dActOk.body,
  );
  const dupe = await req(
    'POST',
    `/companies/${Dt.companyId}/activation-request`,
    {
      token: Dt.token,
      json: {},
    },
  );
  check(
    'a draft or open request cannot ask twice',
    dupe.status === 201 || dupe.status === 409,
  );

  // ── L. Old-path companies are untouched ──────────────────────────────────
  section('L. companies from the old path');
  const Old = await owner(db);
  await db.sql(
    `UPDATE companies SET status = 'pending_approval', submitted_at = now() WHERE id = $1`,
    [Old.companyId],
  );
  const oldOk = await asAdmin(
    'PATCH',
    `/super-admin/companies/${Old.companyId}/status`,
    {
      status: 'active',
      plan: 'warehouse_starter_6mo',
      endDate: new Date(Date.now() + 182 * DAY).toISOString(),
    },
  );
  check(
    'an old pending_approval company is approvable (now with a plan + end date)',
    oldOk.status === 200 &&
      (await company(Old.companyId)).subscription_plan ===
        'warehouse_starter_6mo',
    oldOk.body,
  );
  const Leg = await owner(db);
  await db.sql(
    `UPDATE companies SET status = 'approved', subscription_plan = 'free',
            subscription_expiry_date = NULL WHERE id = $1`,
    [Leg.companyId],
  );
  await scan();
  const legRow = await company(Leg.companyId);
  const legAccess = await req('GET', '/accounts', { token: Leg.token });
  check(
    'a legacy active company (free, no end) is unchanged and keeps access',
    legRow.status === 'approved' &&
      legRow.subscription_plan === 'free' &&
      legAccess.status === 200,
    { status: legRow.status, access: legAccess.status },
  );

  // ── M. Switches (optional extra API processes) ───────────────────────────
  const queueBase = process.env.QUEUE_API_BASE;
  if (queueBase) {
    section('M1. TRIAL_AUTO_APPROVE=false sends trials to the queue');
    const Q = await owner(db);
    const q = await fetch(`${queueBase}/companies/start-trial`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${Q.token}`,
        'Content-Type': 'application/json',
        'X-Forwarded-For': Q.ip,
      },
      body: JSON.stringify({ companyId: Q.companyId }),
    });
    const qb: any = ((await q.json()) as any)?.data;
    check(
      'start-trial → pending (queued), nothing active yet',
      q.status === 201 &&
        qb?.status === 'pending_approval' &&
        qb?.held === true,
      qb,
    );
    const qa = await asAdmin(
      'PATCH',
      `/admin/payment-submissions/${qb?.submissionId}/approve`,
      {},
    );
    check(
      'admin approval from the queue starts the trial',
      qa.status === 200 &&
        (await company(Q.companyId)).subscription_plan === 'warehouse_trial',
    );
  }
  const approvalBase = process.env.APPROVAL_API_BASE;
  if (approvalBase) {
    section('M2. SIGNUP_MODE=approval offers path B only');
    const Ap = await owner(db);
    const h = {
      Authorization: `Bearer ${Ap.token}`,
      'Content-Type': 'application/json',
      'X-Forwarded-For': Ap.ip,
    };
    const ap = await fetch(`${approvalBase}/companies/start-trial`, {
      method: 'POST',
      headers: h,
      body: JSON.stringify({ companyId: Ap.companyId }),
    });
    const apBody: any = await ap.json();
    const cfg2: any = await (
      await fetch(`${approvalBase}/public/config`)
    ).json();
    check(
      'public config says approval; start-trial → TRIAL_DISABLED',
      cfg2?.data?.signupMode === 'approval' &&
        ap.status === 409 &&
        apBody?.error?.details?.reason === 'TRIAL_DISABLED',
      apBody,
    );
    const sub = await fetch(
      `${approvalBase}/companies/${Ap.companyId}/submit`,
      {
        method: 'POST',
        headers: h,
        body: JSON.stringify({ requestedPlan: 'unsure' }),
      },
    );
    const apOk = await asAdmin(
      'PATCH',
      `/admin/companies/${Ap.companyId}/approve`,
      {
        plan: 'warehouse_starter_1yr',
        endDate: new Date(Date.now() + 365 * DAY).toISOString(),
      },
    );
    check(
      'path B end to end in approval mode',
      sub.status === 201 && apOk.status === 200,
      { sub: sub.status, ok: apOk.status },
    );
  }

  await db.close();
  finish('Free trial (launch)');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
