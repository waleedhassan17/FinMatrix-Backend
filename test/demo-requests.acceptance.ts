/**
 * Book a Demo — acceptance (npm run test:demo).
 *
 * Proves, against a running API and its database: the happy path (slots in
 * Asia/Karachi, a booking, the prospect's and the admin's emails), validation,
 * the honeypot and minimum fill time, the per-IP throttle, the open-booking
 * cap, slot conflicts, every status transition (valid and invalid), the .ics
 * invites on schedule / reschedule / cancel, the 2-hours-before reminder, the
 * trial invite and the automatic conversion when the prospect signs up, the
 * CSV export, and that a non-admin can reach none of the admin endpoints.
 *
 * Environment: test/launch-helpers.ts. EXPECT_MAIL=true asserts emails.
 */
import {
  BASE,
  check,
  code,
  data,
  Db,
  finish,
  freshIp,
  freshPhone,
  mailpitAvailable,
  mailText,
  mailTo,
  owner,
  PASSWORD,
  req,
  RUN,
  section,
  signin,
  sleep,
  startTrial,
  superAdmin,
} from './launch-helpers';

async function main() {
  const db = await new Db().open();
  const admin = await superAdmin(db);
  const mail = await mailpitAvailable();
  console.log(
    `\n=== Book a Demo — ${BASE} · mail ${mail ? 'asserted' : 'not asserted'} ===`,
  );
  const asAdmin = (method: string, path: string, json?: unknown) =>
    req(method, path, { token: admin.token, json });

  let seq = 0;
  const slots = async () => data(await req('GET', '/public/demo-slots'));
  /** A valid booking body for slot `at`, with a form token old enough. */
  const body = (
    formToken: string,
    at: string,
    over: Record<string, unknown> = {},
  ) => {
    seq += 1;
    return {
      fullName: `QA Prospect ${seq}`,
      businessName: `QA Traders ${RUN}-${seq}`,
      phone: freshPhone(),
      email: `prospect_${RUN}_${seq}@example.com`,
      city: 'Lahore',
      businessType: 'wholesale_distribution',
      teamSize: '6-20',
      currentSystem: 'tally',
      slot: at,
      message: 'Interested in moving from Tally.',
      consent: true,
      website: '',
      formToken,
      utm: { source: 'google', campaign: 'launch' },
      referrer: 'https://www.google.com/',
      landingPath: '/book-demo',
      ...over,
    };
  };
  const book = (json: unknown, ip = freshIp()) =>
    req('POST', '/public/demo-requests', { json, ip });
  const rowByEmail = (email: string) =>
    db.one(`SELECT * FROM demo_requests WHERE email = $1`, [email]);

  // ── A. Slots + happy path ────────────────────────────────────────────────
  section('A. slots and a booking');
  const s0 = await slots();
  // Booked slots drop out (capacity 1), so on a database earlier runs used
  // the first free slot may be later than 10:00. The rule: every slot is on
  // the half hour between 10:00 and 18:00 PKT, and some day still opens at 10.
  const pkt = (at: string) => new Date(new Date(at).getTime() + 5 * 3600_000);
  const inHours = (s0?.slots ?? []).every((s: any) => {
    const d = pkt(s.at);
    return (
      d.getUTCHours() >= 10 &&
      d.getUTCHours() < 18 &&
      d.getUTCMinutes() % 30 === 0
    );
  });
  const opensAtTen = (s0?.slots ?? []).some((s: any) => s.time === '10:00');
  const weekdays = new Set(
    (s0?.slots ?? []).map((s: any) =>
      new Date(new Date(s.at).getTime() + 5 * 3600_000).getUTCDay(),
    ),
  );
  check(
    'slots: Asia/Karachi, 30 minutes, 10:00–18:00, never on Sunday, never today',
    s0?.timezone === 'Asia/Karachi' &&
      s0?.minutes === 30 &&
      inHours &&
      opensAtTen &&
      !weekdays.has(0) &&
      s0?.slots?.[0]?.date >
        new Date(Date.now() + 5 * 3600_000).toISOString().slice(0, 10),
    s0?.slots?.slice(0, 2),
  );
  const pool: string[] = (s0?.slots ?? []).map((s: any) => s.at);
  let slotIdx = 0;
  const nextSlot = () => pool[slotIdx++];
  await sleep(3200); // the minimum fill time
  const happy = body(s0.formToken, nextSlot());
  const b1 = await book(happy);
  const row1 = await rowByEmail(happy.email as string);
  check(
    'booking → { received: true } and a "new" row with attribution',
    b1.status === 201 &&
      data(b1)?.received === true &&
      Object.keys(data(b1)).length === 1 &&
      row1?.status === 'new' &&
      row1?.phone_e164?.startsWith('+923') &&
      row1?.utm?.source === 'google' &&
      !!row1?.ip_hash,
    { status: b1.status, body: b1.body, row: row1?.status },
  );
  if (mail) {
    const conf = await mailTo(happy.email as string);
    check(
      'the prospect is emailed a confirmation (English)',
      conf.length === 1 &&
        /demo request/i.test(conf[0].Subject) &&
        !/[\u0600-\u06FF]/.test(conf[0].Subject),
      conf.map((m) => m.Subject),
    );
    const adm = await mailTo('platform-admin@example.com', {
      subject: new RegExp(`New demo request: ${happy.businessName}`),
    });
    check('the admin is notified', adm.length === 1, adm.length);
  }
  const s1 = await slots();
  check(
    'the booked slot is no longer offered (capacity 1)',
    !(s1?.slots ?? []).some((s: any) => s.at === happy.slot),
  );

  // ── B. Validation ────────────────────────────────────────────────────────
  section('B. validation');
  const tok = s1.formToken;
  await sleep(3200);
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['bad phone', { phone: '1234567' }, 'DEMO_INVALID_PHONE'],
    [
      'landline is not a mobile',
      { phone: '042 35761234' },
      'DEMO_INVALID_PHONE',
    ],
    ['bad email', { email: 'not-an-email' }, 'VALIDATION_FAILED'],
    ['no consent', { consent: false }, 'VALIDATION_FAILED'],
    ['name too short', { fullName: 'A' }, 'VALIDATION_FAILED'],
    ['unknown business type', { businessType: 'bakery' }, 'VALIDATION_FAILED'],
    [
      'message over 1000 characters',
      { message: 'x'.repeat(1001) },
      'VALIDATION_FAILED',
    ],
    [
      'a time that was never offered',
      { slot: new Date(Date.now() + 86_400_000).toISOString() },
      'DEMO_INVALID_SLOT',
    ],
    ['a forged form token', { formToken: '123.abc' }, 'DEMO_FORM_EXPIRED'],
  ];
  for (const [name, over, expected] of cases) {
    const r = await book(body(tok, nextSlot(), over));
    check(
      `${name} → 400 ${expected}`,
      r.status === 400 && code(r) === expected,
      { status: r.status, code: code(r) },
    );
  }

  // ── C. Bots ──────────────────────────────────────────────────────────────
  section('C. honeypot and minimum fill time');
  const hp = body(tok, nextSlot(), { website: 'http://spam.example' });
  const hpRes = await book(hp);
  check(
    'honeypot filled → same success, nothing stored',
    data(hpRes)?.received === true && !(await rowByEmail(hp.email as string)),
  );
  const fresh = await slots();
  const fast = body(fresh.formToken, nextSlot());
  const fastRes = await book(fast);
  check(
    'submitted under 3 s → same success, nothing stored',
    data(fastRes)?.received === true &&
      !(await rowByEmail(fast.email as string)),
  );

  // ── D. Throttle, open-booking cap, slot conflict ─────────────────────────
  section('D. abuse limits');
  const oneIp = freshIp();
  const statuses: number[] = [];
  for (let i = 0; i < 6; i++) {
    statuses.push(
      (await book(body(tok, nextSlot(), { website: 'bot' }), oneIp)).status,
    );
  }
  check(
    'more than 5 bookings per IP per hour → 429',
    statuses.slice(0, 5).every((s) => s === 201) && statuses[5] === 429,
    statuses,
  );
  const samePhone = freshPhone();
  const c1 = body(tok, nextSlot(), { phone: samePhone });
  const c2 = body(tok, nextSlot(), { phone: samePhone });
  const c3 = body(tok, nextSlot(), { phone: samePhone });
  await book(c1);
  await book(c2);
  const c3Res = await book(c3);
  check(
    'a third open booking for one phone → same success, nothing stored',
    data(c3Res)?.received === true &&
      !!(await rowByEmail(c1.email as string)) &&
      !(await rowByEmail(c3.email as string)),
  );
  const shared = nextSlot();
  const k1Body = body(tok, shared);
  const k1 = await book(k1Body);
  const k2 = await book(body(tok, shared));
  check(
    'the same slot twice → the second gets 409 DEMO_SLOT_TAKEN',
    k1.status === 201 && k2.status === 409 && code(k2) === 'DEMO_SLOT_TAKEN',
    { k1: k1.status, k2: k2.status },
  );

  // ── E. Pipeline ──────────────────────────────────────────────────────────
  section('E. status machine, schedule, .ics');
  const id = row1.id as string;
  const notAdmin = await owner(db);
  const deny = await Promise.all([
    req('GET', '/admin/demo-requests', { token: notAdmin.token }),
    req('PATCH', `/admin/demo-requests/${id}/status`, {
      token: notAdmin.token,
      json: { status: 'contacted' },
    }),
    req('POST', `/admin/demo-requests/${id}/schedule`, {
      token: notAdmin.token,
      json: { scheduledAt: new Date(Date.now() + 86_400_000).toISOString() },
    }),
    req('GET', '/admin/demo-requests/export.csv', { token: notAdmin.token }),
  ]);
  check(
    'a company owner can reach none of the admin endpoints',
    deny.every((r) => r.status === 403),
    deny.map((r) => r.status),
  );
  const bad1 = await asAdmin('PATCH', `/admin/demo-requests/${id}/status`, {
    status: 'completed',
  });
  check(
    'new → completed is refused (409 DEMO_INVALID_TRANSITION)',
    bad1.status === 409 && code(bad1) === 'DEMO_INVALID_TRANSITION',
    code(bad1),
  );
  const lostNoReason = await asAdmin(
    'PATCH',
    `/admin/demo-requests/${id}/status`,
    { status: 'lost' },
  );
  check(
    'lost without a reason → 400',
    lostNoReason.status === 400 &&
      code(lostNoReason) === 'DEMO_LOST_REASON_REQUIRED',
  );
  const contacted = await asAdmin(
    'PATCH',
    `/admin/demo-requests/${id}/status`,
    { status: 'contacted' },
  );
  check(
    'new → contacted',
    data(contacted)?.status === 'contacted',
    contacted.body,
  );
  const at1 = new Date(Date.now() + 3 * 86_400_000);
  const sched = await asAdmin('POST', `/admin/demo-requests/${id}/schedule`, {
    scheduledAt: at1.toISOString(),
    meetingLink: 'https://meet.example.com/finmatrix-qa',
  });
  check(
    'contacted → scheduled with a time and meeting link',
    data(sched)?.status === 'scheduled' &&
      data(sched)?.meetingLink === 'https://meet.example.com/finmatrix-qa',
    sched.body,
  );
  const again = await asAdmin('POST', `/admin/demo-requests/${id}/schedule`, {
    scheduledAt: at1.toISOString(),
  });
  check(
    'scheduling a scheduled demo is refused (use reschedule)',
    again.status === 409,
    again.status,
  );
  const at2 = new Date(Date.now() + 4 * 86_400_000);
  const resched = await asAdmin(
    'POST',
    `/admin/demo-requests/${id}/reschedule`,
    { scheduledAt: at2.toISOString() },
  );
  const r1 = await rowByEmail(happy.email as string);
  check(
    'reschedule: new time, still scheduled, invite sequence bumped',
    data(resched)?.status === 'scheduled' &&
      new Date(r1.scheduled_at).getTime() === at2.getTime() &&
      r1.ics_sequence === 1,
    resched.body,
  );
  if (mail) {
    const msgs = await mailTo(happy.email as string, { waitMs: 5000 });
    const withIcs = msgs.filter((m) => m.Attachments > 0);
    check(
      'schedule and reschedule emails carry the .ics invite',
      withIcs.length >= 2,
      msgs.map((m) => `${m.Subject}:${m.Attachments}`),
    );
    if (withIcs[0]) {
      const raw = await (
        await fetch(
          `${process.env.MAILPIT_URL ?? 'http://localhost:8025'}/api/v1/message/${withIcs[0].ID}/raw`,
        )
      ).text();
      check(
        'the invite is a valid VCALENDAR with METHOD:REQUEST and the meeting link',
        /BEGIN:VCALENDAR/.test(raw) || /QkVHSU46VkNBTEVOREFS/.test(raw),
        raw.length,
      );
    }
  }
  const done = await asAdmin('PATCH', `/admin/demo-requests/${id}/status`, {
    status: 'completed',
  });
  check('scheduled → completed', data(done)?.status === 'completed');
  // A second demo: scheduled then lost → cancellation.
  const other = await db.one(
    `SELECT id, email FROM demo_requests WHERE email = $1`,
    [c1.email],
  );
  await asAdmin('POST', `/admin/demo-requests/${other.id}/schedule`, {
    scheduledAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
  });
  const lost = await asAdmin(
    'PATCH',
    `/admin/demo-requests/${other.id}/status`,
    { status: 'lost', reason: 'QA: chose another vendor' },
  );
  check(
    'scheduled → lost with a reason',
    data(lost)?.status === 'lost' &&
      data(lost)?.lostReason === 'QA: chose another vendor',
  );
  const revive = await asAdmin(
    'PATCH',
    `/admin/demo-requests/${other.id}/status`,
    { status: 'contacted' },
  );
  check('lost is final (409)', revive.status === 409);
  if (mail) {
    const cancel = await mailTo(other.email, { subject: /cancelled/i });
    check(
      'a lost scheduled demo sends a cancellation with METHOD:CANCEL',
      cancel.length === 1 && cancel[0].Attachments >= 1,
      cancel,
    );
  }
  const note = await asAdmin('POST', `/admin/demo-requests/${id}/notes`, {
    body: 'Uses Tally Prime 4; 3 branches.',
  });
  const badAssign = await asAdmin(
    'PATCH',
    `/admin/demo-requests/${id}/assign`,
    { userId: notAdmin.userId },
  );
  const goodAssign = await asAdmin(
    'PATCH',
    `/admin/demo-requests/${id}/assign`,
    { userId: admin.id },
  );
  const detail = data(await asAdmin('GET', `/admin/demo-requests/${id}`));
  check(
    'notes, assignment (team members only) and the audited history',
    note.status === 201 &&
      badAssign.status === 400 &&
      data(goodAssign)?.assignedTo === admin.id &&
      detail?.notes?.length === 1 &&
      detail?.history?.some((h: any) => h.action === 'demo_rescheduled'),
    { note: note.status, bad: badAssign.status },
  );

  // ── F. Reminder ──────────────────────────────────────────────────────────
  section('F. 2-hours-before reminder');
  const rem = await db.one(`SELECT id FROM demo_requests WHERE email = $1`, [
    c2.email,
  ]);
  await asAdmin('POST', `/admin/demo-requests/${rem.id}/schedule`, {
    scheduledAt: new Date(Date.now() + 90 * 60_000).toISOString(),
    meetingLink: 'https://meet.example.com/soon',
  });
  const far = await db.one(`SELECT id FROM demo_requests WHERE email = $1`, [
    k1Body.email,
  ]);
  await asAdmin('POST', `/admin/demo-requests/${far.id}/schedule`, {
    scheduledAt: new Date(Date.now() + 5 * 3600_000).toISOString(),
  });
  const run1 = data(
    await asAdmin('POST', '/admin/demo-requests/run-reminders'),
  );
  const run2 = data(
    await asAdmin('POST', '/admin/demo-requests/run-reminders'),
  );
  const remRow = await db.one(
    `SELECT reminder_sent_at FROM demo_requests WHERE id = $1`,
    [rem.id],
  );
  const farRow = await db.one(
    `SELECT reminder_sent_at FROM demo_requests WHERE id = $1`,
    [far.id],
  );
  check(
    'a demo 90 minutes away is reminded once; one 5 hours away is not',
    run1?.sent >= 1 &&
      run2?.sent === 0 &&
      !!remRow.reminder_sent_at &&
      !farRow.reminder_sent_at,
    { run1, run2 },
  );

  // ── G. Demo → trial ──────────────────────────────────────────────────────
  section('G. trial invite and conversion');
  const inv = await asAdmin('POST', `/admin/demo-requests/${id}/trial-invite`);
  const url = new URL(data(inv)?.signupUrl);
  check(
    'the invite link pre-fills name, email and business, ref=demo_<id>',
    url.pathname === '/register' &&
      url.searchParams.get('ref') === `demo_${id}` &&
      url.searchParams.get('email') === happy.email &&
      url.searchParams.get('business') === happy.businessName &&
      data(inv)?.trialEligible === true,
    data(inv),
  );
  if (mail) {
    const invMail = await mailTo(happy.email as string, {
      subject: /free trial/i,
    });
    if (invMail[0])
      check(
        'the invite email carries the sign-up link',
        (await mailText(invMail[0].ID)).includes(`ref=demo_${id}`),
      );
  }
  const ip = freshIp();
  const su = await req('POST', '/auth/signup', {
    ip,
    json: {
      email: happy.email,
      password: PASSWORD,
      displayName: happy.fullName,
      role: 'admin',
      ref: `demo_${id}`,
    },
  });
  const uid = data(su)?.user?.id;
  await db.sql(`UPDATE users SET is_email_verified = true WHERE id = $1`, [
    uid,
  ]);
  const tok1 = await signin(happy.email as string, PASSWORD, ip);
  const co = await req('POST', '/companies', {
    token: tok1,
    ip,
    json: { name: happy.businessName, phone: happy.phone },
  });
  const companyId = data(co)?.id;
  const conv = await db.one(
    `SELECT status, converted_company_id FROM demo_requests WHERE id = $1`,
    [id],
  );
  check(
    'creating the company marks the demo converted and links it',
    conv.status === 'converted' && conv.converted_company_id === companyId,
    conv,
  );
  const tok2 = await signin(happy.email as string, PASSWORD, ip);
  const trial = await startTrial({
    email: happy.email as string,
    userId: uid,
    token: tok2,
    companyId,
    phone: happy.phone as string,
    ip,
  });
  const trials = data(
    await asAdmin('GET', '/admin/trials?view=active&limit=100'),
  );
  check(
    'the trial starts and the admin list flags it "from demo"',
    trial.status === 201 &&
      trials?.items?.some(
        (t: any) => t.companyId === companyId && t.fromDemo === true,
      ),
    trial.body,
  );
  const ineligible = await db.one(
    `SELECT id FROM demo_requests WHERE email = $1`,
    [c2.email],
  );
  await db.sql(`UPDATE demo_requests SET phone_e164 = $2 WHERE id = $1`, [
    ineligible.id,
    happy.phone ? `+92${String(happy.phone).slice(1)}` : '',
  ]);
  const inv2 = data(
    await asAdmin('POST', `/admin/demo-requests/${ineligible.id}/trial-invite`),
  );
  check(
    'an invite to someone whose phone already trialed offers approval instead',
    inv2?.trialEligible === false,
    inv2,
  );

  // ── H. CSV export ────────────────────────────────────────────────────────
  section('H. export');
  const csv = await fetch(
    `${BASE}/admin/demo-requests/export.csv?q=${encodeURIComponent(happy.businessName as string)}`,
    { headers: { Authorization: `Bearer ${admin.token}` } },
  );
  const text = await csv.text();
  check(
    'CSV export with a header and the row',
    csv.status === 200 &&
      /full_name,business_name/.test(text) &&
      text.includes(happy.businessName as string),
    text.slice(0, 200),
  );
  const list = data(
    await asAdmin(
      'GET',
      `/admin/demo-requests?status=converted&q=${encodeURIComponent(happy.businessName as string)}`,
    ),
  );
  check(
    'list filters by status and search, with counts per status',
    list?.items?.length === 1 && typeof list?.counts?.converted === 'number',
    list?.counts,
  );

  await db.close();
  finish('Book a Demo');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
