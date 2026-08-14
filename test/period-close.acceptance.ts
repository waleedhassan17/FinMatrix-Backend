/**
 * FinMatrix — Period Close Acceptance (audit gap G4)
 * ==================================================
 * books_locked_until was NULL on every company, so the period lock had never
 * run against real data and invariant I12 had never had anything to catch.
 *
 *   A. Closing the books is tier-gated and validated
 *   B. EVERY document type is refused in a closed period — dated before the
 *      lock, and ON the lock date (the rule is date <= lock, so the boundary
 *      day is closed, not open)
 *   C. The same documents post fine dated AFTER the lock
 *   D. A draft may be created in a closed period but not posted
 *   E. Reopening restores posting
 *   F. I12 — corrected to compare against books_locked_at — is silent on
 *      legitimate history and ACTIVELY catches a back-dated posting. The
 *      audited form of I12 is asserted to be the false-positive machine it is.
 *   G. Retained earnings: this system derives them at report time rather than
 *      posting closing entries, so equity must reflect prior income with no
 *      year-end journal
 *
 * Usage: boot the API, then
 *   API_BASE=http://localhost:3000/api/v1 DATABASE_URL=postgres://... \
 *   npx ts-node -r tsconfig-paths/register test/period-close.acceptance.ts
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';

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
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`,
    );
  }
};
const n = (v: unknown) => Number(v ?? 0) || 0;
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

let TOKEN = '';
let COMPANY = '';

async function req(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (COMPANY) headers['x-company-id'] = COMPANY;
  // The API throttles (THROTTLE_LIMIT requests per THROTTLE_TTL). Running the
  // accounting suites back to back trips it, and a 429 is not a test failure —
  // back off and retry rather than reporting rate limiting as a broken ledger.
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 3) {
      // /auth/signin is capped at 5 per minute by a route-level @Throttle —
      // brute-force protection worth keeping, and not something a test should
      // turn off. Wait out the whole window for auth; back off more gently for
      // everything else, which only trips the global limit.
      const wait = path.startsWith('/auth') ? 65_000 : 15_000 * (attempt + 1);
      console.log(`    (throttled on ${path} — waiting ${Math.round(wait / 1000)}s)`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    let parsed: any = null;
    try {
      parsed = await res.json();
    } catch {
      /* empty */
    }
    return { status: res.status, body: parsed };
  }
}
const data = (r: { body: any }) => r.body?.data ?? r.body;
const errCode = (r: { body: any }) => r.body?.error?.code ?? r.body?.code;

async function main() {
  const db = new Client({ connectionString: DB });
  await db.connect();

  console.log(`\nFinMatrix Period Close (G4) → ${API}\n`);

  const login = await req('POST', '/auth/signin', { email: EMAIL, password: PASSWORD });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  ok('admin signs in', !!TOKEN && !!COMPANY, login.status);
  if (!TOKEN) throw new Error('cannot sign in');

  // Make sure we start from an open period whatever a previous run left behind.
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  const customer = (data(await req('GET', '/customers?limit=1')) as any)?.data?.[0];
  const vendorRes = data(await req('GET', '/vendors?limit=1')) as any;
  const vendor = vendorRes?.data?.[0] ?? vendorRes?.[0];
  const itemsRes = data(await req('GET', '/inventory/items?limit=50')) as any;
  const item = (itemsRes?.data ?? itemsRes ?? []).find(
    (i: any) => n(i.unitCost) > 0 && n(i.quantityOnHand) > 20,
  );
  const accountsRes = data(await req('GET', '/accounts?limit=200')) as any;
  const accounts = accountsRes?.accounts ?? accountsRes?.data ?? accountsRes ?? [];
  const cash = accounts.find((a: any) => a.accountNumber === '1000');
  const revenue = accounts.find((a: any) => a.accountNumber === '4000');
  ok('master data resolved',
    !!customer && !!vendor && !!item && !!cash && !!revenue, {
      customer: !!customer, vendor: !!vendor, item: !!item,
      cash: !!cash, revenue: !!revenue,
    });
  if (!customer || !cash || !revenue) throw new Error('missing master data');

  // Dates either side of the lock. The lock lands on LOCK_DATE itself, which
  // must be CLOSED — the engine's rule is `date <= lock`.
  const LOCK_DATE = '2026-07-31';
  const BEFORE = '2026-07-15';
  const ON = LOCK_DATE;
  const AFTER = '2026-08-14';

  // ══ A. Closing the books ═══════════════════════════════════════
  console.log('\n— A: closing the books');

  const future = await req('POST', `/companies/${COMPANY}/period-close`, {
    lockDate: '2099-01-01',
  });
  ok('A refuses to close a period that has not happened yet',
    future.status === 400 && errCode(future) === 'LOCK_DATE_IN_FUTURE', future.body);

  const closed = await req('POST', `/companies/${COMPANY}/period-close`, {
    lockDate: LOCK_DATE,
  });
  ok('A books closed through the lock date',
    closed.status === 200 || closed.status === 201, closed.body);

  const { rows: lockRows } = await db.query(
    `SELECT books_locked_until::text AS until, books_locked_at FROM companies WHERE id = $1`,
    [COMPANY],
  );
  ok('A lock date persisted', lockRows[0]?.until === LOCK_DATE, lockRows[0]);
  ok('A the TIME of the close is stamped too — this is what makes back-dating detectable',
    !!lockRows[0]?.books_locked_at, lockRows[0]);

  const earlier = await req('POST', `/companies/${COMPANY}/period-close`, {
    lockDate: '2026-06-30',
  });
  ok('A refuses to silently reopen by moving the lock backwards',
    earlier.status === 400 && errCode(earlier) === 'PERIOD_ALREADY_CLOSED', earlier.body);

  // ══ B/C. Every document type, either side of the lock ══════════
  console.log('\n— B/C: every document type, before / on / after the lock');

  const invoicePayload = (date: string) => ({
    customerId: customer.id,
    invoiceDate: date,
    dueDate: '2099-12-31',
    status: 'sent',
    lines: [{ description: 'G4 probe', quantity: '1', unitPrice: '100', taxRate: '0' }],
  });
  const billPayload = (date: string) => ({
    vendorId: vendor.id,
    billNumber: `G4-${date}-${Date.now()}`,
    billDate: date,
    dueDate: '2099-12-31',
    lines: [{ description: 'G4 probe', quantity: '1', unitPrice: '100' }],
  });
  const journalPayload = (date: string) => ({
    date,
    memo: 'G4 probe',
    status: 'posted',
    lines: [
      { accountId: cash.id, debit: '10', credit: '0', lineOrder: 0 },
      { accountId: revenue.id, debit: '0', credit: '10', lineOrder: 1 },
    ],
  });
  const taxPayload = (date: string, rateId: string) => ({
    taxRateId: rateId,
    period: date.slice(0, 7),
    amount: '10',
    paymentDate: date,
  });

  const rate = data(
    await req('POST', '/taxes/rates', {
      name: `G4 rate ${Date.now()}`,
      rate: '17',
      taxType: 'sales',
    }),
  ) as any;

  const docs: Array<{ label: string; post: (d: string) => Promise<any> }> = [
    { label: 'invoice', post: (d) => req('POST', '/invoices', invoicePayload(d)) },
    { label: 'bill', post: (d) => req('POST', '/bills', billPayload(d)) },
    { label: 'journal entry', post: (d) => req('POST', '/journal-entries', journalPayload(d)) },
    { label: 'tax payment', post: (d) => req('POST', '/taxes/payments', taxPayload(d, rate.id)) },
  ];

  for (const doc of docs) {
    const before = await doc.post(BEFORE);
    ok(`B ${doc.label} dated BEFORE the lock → PERIOD_LOCKED`,
      errCode(before) === 'PERIOD_LOCKED', { status: before.status, body: before.body });

    const on = await doc.post(ON);
    ok(`B ${doc.label} dated ON the lock date → PERIOD_LOCKED (rule is date <= lock)`,
      errCode(on) === 'PERIOD_LOCKED', { status: on.status, body: on.body });

    const after = await doc.post(AFTER);
    ok(`C ${doc.label} dated AFTER the lock → posts`,
      after.status === 200 || after.status === 201, {
        status: after.status, body: after.body,
      });
  }

  // Payment carries its own date; check it separately against a live invoice.
  const payTarget = data(await req('POST', '/invoices', invoicePayload(AFTER))) as any;
  const payBefore = await req('POST', '/payments', {
    customerId: customer.id,
    paymentDate: BEFORE,
    amount: '10',
    paymentMethod: 'cash',
    applications: [{ invoiceId: payTarget.id, amount: '10' }],
  });
  ok('B payment dated BEFORE the lock → PERIOD_LOCKED',
    errCode(payBefore) === 'PERIOD_LOCKED', { status: payBefore.status, body: payBefore.body });

  const payAfter = await req('POST', '/payments', {
    customerId: customer.id,
    paymentDate: AFTER,
    amount: '10',
    paymentMethod: 'cash',
    applications: [{ invoiceId: payTarget.id, amount: '10' }],
  });
  ok('C payment dated AFTER the lock → posts',
    payAfter.status === 200 || payAfter.status === 201, payAfter.status);

  // Inventory movement (adjustment) posts at today's date, so it should work.
  if (item) {
    const adj = await req('POST', `/inventory/items/${item.id}/adjust`, {
      itemId: item.id,
      newQty: String(n(item.quantityOnHand) - 1),
      reason: 'correction',
      notes: 'G4 probe',
    });
    ok('C inventory movement dated today (after the lock) → posts',
      adj.status === 200 || adj.status === 201, adj.status);
  }

  // ══ D. Drafts ══════════════════════════════════════════════════
  console.log('\n— D: drafts in a closed period');
  const draft = await req('POST', '/journal-entries', {
    ...journalPayload(BEFORE),
    status: 'draft',
  });
  ok('D a DRAFT may be created in a closed period',
    draft.status === 200 || draft.status === 201, draft.body);

  if (draft.status < 300) {
    const draftId = (data(draft) as any).id;
    const posted = await req('POST', `/journal-entries/${draftId}/post`);
    ok('D but posting that draft is refused → PERIOD_LOCKED',
      errCode(posted) === 'PERIOD_LOCKED', { status: posted.status, body: posted.body });
  }

  // ══ F. I12, old and new ════════════════════════════════════════
  console.log('\n— F: the closed-period invariant');

  const I12_AUDITED = `
    SELECT count(*)::int AS c
      FROM journal_entries e JOIN companies c ON c.id = e.company_id
     WHERE c.books_locked_until IS NOT NULL
       AND e.date <= c.books_locked_until
       AND e.status = 'posted'`;

  const I12_CORRECTED = `
    SELECT count(*)::int AS c
      FROM journal_entries e JOIN companies c ON c.id = e.company_id
     WHERE c.books_locked_until IS NOT NULL
       AND c.books_locked_at IS NOT NULL
       AND e.date <= c.books_locked_until
       AND e.created_at > c.books_locked_at
       AND e.status = 'posted'`;

  const audited = await db.query(I12_AUDITED);
  ok('F the AUDITED I12 flags legitimate history — it is a false-positive machine',
    n(audited.rows[0]?.c) > 0, {
      flagged: audited.rows[0]?.c,
      note: 'every entry dated in the now-closed period, all posted before the close',
    });

  const corrected = await db.query(I12_CORRECTED);
  ok('F the CORRECTED I12 is silent on that same history',
    n(corrected.rows[0]?.c) === 0, corrected.rows[0]);

  // Now back-date an entry straight into the closed period, bypassing the API
  // exactly as a rogue script would, and prove the corrected invariant sees it.
  const { rows: userRow } = await db.query(
    `SELECT created_by FROM journal_entries WHERE company_id = $1 LIMIT 1`,
    [COMPANY],
  );
  const { rows: acctRows } = await db.query(
    `SELECT id FROM accounts WHERE company_id = $1 LIMIT 2`,
    [COMPANY],
  );
  await db.query('BEGIN');
  const { rows: sneak } = await db.query(
    `INSERT INTO journal_entries
       (company_id, reference, date, status, total_debits, total_credits, created_by)
     VALUES ($1, 'G4-BACKDATED', $2, 'posted', 10, 10, $3) RETURNING id`,
    [COMPANY, BEFORE, userRow[0].created_by],
  );
  await db.query(
    `INSERT INTO journal_entry_lines (entry_id, account_id, debit, credit, line_order)
     VALUES ($1, $2, 10, 0, 0), ($1, $3, 0, 10, 1)`,
    [sneak[0].id, acctRows[0].id, acctRows[1].id],
  );
  await db.query('COMMIT');

  const caught = await db.query(I12_CORRECTED);
  ok('F the corrected I12 CATCHES an entry back-dated into the closed period',
    n(caught.rows[0]?.c) === 1, caught.rows[0]);

  await db.query(`DELETE FROM journal_entries WHERE id = $1`, [sneak[0].id]);
  const cleaned = await db.query(I12_CORRECTED);
  ok('F silent again once the back-dated entry is removed',
    n(cleaned.rows[0]?.c) === 0, cleaned.rows[0]);

  // ══ E. Reopen ══════════════════════════════════════════════════
  console.log('\n— E: reopening');
  const reopened = await req('POST', `/companies/${COMPANY}/period-reopen`);
  ok('E books reopened', reopened.status === 200 || reopened.status === 201, reopened.body);

  const afterReopen = await req('POST', '/invoices', invoicePayload(BEFORE));
  ok('E the previously refused date now posts',
    afterReopen.status === 201, { status: afterReopen.status, body: afterReopen.body });

  const reopenAgain = await req('POST', `/companies/${COMPANY}/period-reopen`);
  ok('E reopening already-open books is refused',
    reopenAgain.status === 400 && errCode(reopenAgain) === 'PERIOD_NOT_CLOSED',
    reopenAgain.body);

  // ══ G. Retained earnings are derived, not posted ═══════════════
  console.log('\n— G: retained earnings (derived, no closing entries)');

  const { rows: closingEntries } = await db.query(
    `SELECT count(*)::int AS c FROM journal_entries
      WHERE company_id = $1 AND (memo ILIKE '%closing entry%' OR memo ILIKE '%year-end close%')`,
    [COMPANY],
  );
  ok('G this system posts NO year-end closing entries — the design is derived',
    n(closingEntries[0]?.c) === 0, closingEntries[0]);

  const bs = data(await req('GET', `/reports/balance-sheet?asOfDate=2026-12-31`)) as any;
  const pl = data(
    await req('GET', `/reports/profit-loss?startDate=1970-01-01&endDate=2026-12-31`),
  ) as any;
  const equityIncome = (bs?.equity ?? []).reduce(
    (s: number, e: any) => (e.accountName?.includes('Net Income') ? s + n(e.amount) : s),
    0,
  );
  ok('G cumulative net income is carried into equity at report time',
    near(equityIncome, n(pl?.netIncome)), {
      equityLine: equityIncome, plNetIncome: pl?.netIncome,
    });
  ok('G balance sheet balances with the derived earnings line',
    bs?.isBalanced === true, {
      assets: bs?.totalAssets,
      liabEquity: n(bs?.totalLiabilities) + n(bs?.totalEquity),
    });

  // ══ Invariants ═════════════════════════════════════════════════
  console.log('\n— invariants');
  const checks: Array<[string, string]> = [
    ['I1 global imbalance', `SELECT 1 FROM journal_entry_lines HAVING sum(debit) <> sum(credit)`],
    ['I2 unbalanced entry', `SELECT 1 FROM journal_entry_lines GROUP BY entry_id HAVING sum(debit) <> sum(credit)`],
    ['I4 bad line shape', `SELECT 1 FROM journal_entry_lines WHERE (debit>0 AND credit>0) OR (debit=0 AND credit=0) OR debit<0 OR credit<0`],
    ['I8 invoice math', `SELECT 1 FROM invoices WHERE total - amount_paid <> balance`],
    ['I11 negative stock', `SELECT 1 FROM inventory_items WHERE quantity_on_hand < 0`],
    ['I12 closed-period posting (corrected)', I12_CORRECTED.replace('count(*)::int AS c', '1').replace('SELECT 1\n', 'SELECT 1 ')],
  ];
  for (const [name, sql] of checks) {
    const { rows } = await db.query(sql);
    const violations = name.startsWith('I12') ? rows.filter((r: any) => r.c !== 0) : rows;
    ok(`[final] ${name}`, violations.length === 0, violations.slice(0, 2));
  }

  await db.end();

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('SUITE ERROR:', e);
  process.exit(1);
});
