/**
 * FinMatrix — Day Summary acceptance.
 * ===================================
 * GET /reports/day-summary answers "what did the business do today?". This
 * suite posts real documents and checks the summary moves by exactly them:
 *
 *   A. An invoice, a receipt, a sales order, a draft and a back-dated invoice
 *      land where they should: counted, uncounted, flagged — and the Day Book
 *      lists each under its filter.
 *   B. A voided invoice leaves the totals and shows under "voided".
 *   C. Comparisons: previousDay matches the day before's own summary, and the
 *      7-day trend ends on today's figure.
 *   D. Staff see only what they prepared. An invoice an owner approves for a
 *      staff member is credited to that staff member, not the owner.
 *   F. The Day Book pages, totals across pages, searches (literally) and sorts.
 *   E. The digest schedule: owner-only, validated, and the hourly job sends
 *      one notification per day (a morning digest covers the day before).
 *
 * Every assertion is a DELTA across the step, so the suite holds on books that
 * already contain data. E boots the app in-process to call the cron directly,
 * so it needs the same DB_* settings as the API (skip with DS_SKIP_CRON=true).
 *
 * Usage: boot the API (isolated — see the README's test notes), then
 *   API_BASE=http://localhost:3000/api/v1 DATABASE_URL=postgres://... \
 *   npx ts-node -r tsconfig-paths/register test/day-summary.acceptance.ts
 */
import {
  addDaysIso,
  businessToday,
} from '../src/common/utils/business-date.util';
import { zonedTimeToUtc } from '../src/modules/messaging/quiet-hours.util';
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';
const TODAY = businessToday();
const YESTERDAY = addDaysIso(TODAY, -1);
const RUN = Date.now().toString().slice(-8);

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
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
const n = (v: unknown) => Number(v ?? 0) || 0;

let TOKEN = '';
let COMPANY = '';

async function req(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const auth = token ?? TOKEN;
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (COMPANY) headers['x-company-id'] = COMPANY;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 3) {
      const wait = path.startsWith('/auth') ? 65_000 : 15_000 * (attempt + 1);
      console.log(`    (throttled on ${path} — waiting ${wait / 1000}s)`);
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
const codeOf = (r: { body: any }) => r.body?.error?.code ?? r.body?.code;

async function main() {
  if (!DB) throw new Error('DATABASE_URL is required');
  const db = new Client({ connectionString: DB });
  await db.connect();
  const sql = async (q: string, p: unknown[] = []) =>
    (await db.query(q, p)).rows;

  console.log(`\nFinMatrix — Day Summary → ${API}\n`);

  const login = await req('POST', '/auth/signin', {
    email: EMAIL,
    password: PASSWORD,
  });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  ok('owner signs in', !!TOKEN && !!COMPANY, login.status);
  if (!TOKEN) throw new Error('cannot sign in');
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  const summary = async (q = '', token?: string) =>
    data(await req('GET', `/reports/day-summary${q}`, undefined, token)) as any;
  const entries = async (q: string, token?: string) =>
    data(
      await req('GET', `/reports/day-summary/entries${q}`, undefined, token),
    ) as any;
  const ids = (page: any) => new Set((page?.items ?? []).map((i: any) => i.id));
  const docCount = (s: any, kind: string) =>
    n(s?.documents?.find((d: any) => d.kind === kind)?.count);
  const cashIn = (s: any, method: string) =>
    n(s?.cash?.methods?.find((m: any) => m.method === method)?.received);

  const customer = data(
    await req('POST', '/customers', { name: `Day Summary Buyer ${RUN}` }),
  );
  ok('a customer to sell to', !!customer?.id, customer);
  const invoice = async (
    amount: number,
    extra: Record<string, unknown> = {},
    token?: string,
  ) =>
    req(
      'POST',
      '/invoices',
      {
        customerId: customer.id,
        invoiceDate: TODAY,
        dueDate: TODAY,
        status: 'sent',
        lines: [
          {
            description: `Day summary line ${RUN}`,
            quantity: '1',
            unitPrice: String(amount),
            taxRate: '0',
            lineKind: 'service',
          },
        ],
        ...extra,
      },
      token,
    );

  // ═══════════════════════════════════════════════════════════════
  // A. Documents land where they should
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— A. a day of documents');
  const s0 = await summary();
  ok(
    'A0 the summary defaults to the business day and the owner view',
    s0?.date === TODAY && s0?.scope?.ownOnly === false && !!s0?.team,
    { date: s0?.date, scope: s0?.scope },
  );

  const sale = data(await invoice(1000));
  const receipt = data(
    await req('POST', '/payments', {
      customerId: customer.id,
      paymentDate: TODAY,
      paymentMethod: 'cash',
      amount: '400.00',
      applications: [{ invoiceId: sale?.id, amount: '400.00' }],
    }),
  );
  const order = data(
    await req('POST', '/sales-orders', {
      customerId: customer.id,
      orderDate: TODAY,
      lines: [
        {
          description: `Day summary order ${RUN}`,
          lineKind: 'service',
          quantity: '1',
          unitPrice: '700',
          taxRate: '0',
        },
      ],
    }),
  );
  const draft = data(await invoice(300, { status: 'draft' }));
  const backdated = data(
    await invoice(250, {
      invoiceDate: addDaysIso(TODAY, -3),
      dueDate: addDaysIso(TODAY, -3),
    }),
  );
  ok(
    'A1 the documents are created',
    !!sale?.id &&
      !!receipt?.id &&
      !!order?.id &&
      !!draft?.id &&
      !!backdated?.id,
    { sale: sale?.id, receipt: receipt?.id, order: order?.id },
  );

  const s1 = await summary();
  const d = (path: (s: any) => unknown) => n(path(s1)) - n(path(s0));
  ok(
    'A2 sales +1 invoice / +1,000 (the draft and the back-dated one are not today’s sales)',
    d((s) => s.headline.sales.count) === 1 &&
      near(
        d((s) => s.headline.sales.total),
        1000,
      ),
    {
      count: d((s) => s.headline.sales.count),
      total: d((s) => s.headline.sales.total),
    },
  );
  ok(
    'A3 received +400, all of it cash',
    near(
      d((s) => s.headline.received.total),
      400,
    ) && near(cashIn(s1, 'cash') - cashIn(s0, 'cash'), 400),
    { received: d((s) => s.headline.received.total) },
  );
  ok(
    'A4 orders booked +1 / +700',
    d((s) => s.headline.orders?.count) === 1 &&
      near(
        d((s) => s.headline.orders?.total),
        700,
      ),
    s1?.headline?.orders,
  );
  ok(
    'A5 the documents grid agrees (invoice +1, sales order +1, receipt +1)',
    docCount(s1, 'invoice') - docCount(s0, 'invoice') === 1 &&
      docCount(s1, 'sales_order') - docCount(s0, 'sales_order') === 1 &&
      docCount(s1, 'receipt') - docCount(s0, 'receipt') === 1,
    s1?.documents,
  );
  ok(
    'A6 still unpaid from today’s sales +600',
    near(
      d((s) => s.sales.unpaid),
      600,
    ),
    { unpaid: d((s) => s.sales.unpaid) },
  );
  ok(
    'A7 attention: +1 draft, +1 back-dated',
    d((s) => s.attention.drafts) === 1 && d((s) => s.attention.backdated) === 1,
    s1?.attention,
  );
  const ownerRow = (s: any) =>
    (s?.team ?? []).find((t: any) => t.name === 'Warehouse Admin') ??
    (s?.team ?? [])[0];
  ok(
    'A8 the team row of the person who entered them moves too',
    n(ownerRow(s1)?.invoices?.count) - n(ownerRow(s0)?.invoices?.count) === 1,
    { before: ownerRow(s0)?.invoices, after: ownerRow(s1)?.invoices },
  );
  const hourSum = (s: any, key: 'sales' | 'received') =>
    (s?.hourly ?? []).reduce((t: number, h: any) => t + n(h[key]), 0);
  ok(
    'A8b the hours add up to the day (24 rows; sales and receipts)',
    s1?.hourly?.length === 24 &&
      near(hourSum(s1, 'sales'), n(s1.headline.sales.total)) &&
      near(hourSum(s1, 'received'), n(s1.headline.received.total)),
    { sales: hourSum(s1, 'sales'), headline: s1?.headline?.sales?.total },
  );
  ok(
    'A9 the owner gets the day’s P&L and the member list',
    !!s1?.profit &&
      typeof s1.profit.grossProfit === 'number' &&
      Array.isArray(s1?.members) &&
      s1.members.length > 0,
    { profit: s1?.profit, members: s1?.members?.length },
  );

  const all = await entries(`?limit=1000`);
  const onlyInvoices = await entries(`?type=invoice&limit=1000`);
  const drafts = await entries(`?type=drafts&limit=1000`);
  const back = await entries(`?type=backdated&limit=1000`);
  ok(
    'A10 the Day Book lists today’s documents (and not the back-dated one)',
    ids(all).has(sale.id) &&
      ids(all).has(receipt.id) &&
      ids(all).has(order.id) &&
      !ids(all).has(backdated.id),
    { total: all?.total },
  );
  const draftRow = (onlyInvoices?.items ?? []).find(
    (i: any) => i.id === draft.id,
  );
  ok(
    'A11 the invoice filter shows the draft, marked as not counted',
    !!draftRow && draftRow.counted === false && draftRow.status === 'draft',
    draftRow,
  );
  ok(
    'A12 the drafts filter has the draft',
    ids(drafts).has(draft.id),
    drafts?.total,
  );
  const backRow = (back?.items ?? []).find((i: any) => i.id === backdated.id);
  ok(
    'A13 the back-dated filter has the back-dated invoice, flagged',
    !!backRow &&
      backRow.backdated === true &&
      backRow.date === addDaysIso(TODAY, -3),
    backRow,
  );
  const latest = (all?.items ?? [])[0];
  ok(
    'A14 newest first, with who entered it',
    !!latest?.createdBy?.name &&
      (all?.items ?? []).every(
        (i: any, k: number, arr: any[]) =>
          k === 0 || arr[k - 1].createdAt >= i.createdAt,
      ),
    latest,
  );

  // ═══════════════════════════════════════════════════════════════
  // B. A void leaves the totals and shows as voided
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— B. voids');
  const doomed = data(await invoice(150));
  const sB0 = await summary();
  const voided = await req('POST', `/invoices/${doomed?.id}/void`, {
    reason: 'day summary test',
  });
  const sB1 = await summary();
  ok(
    'B1 the void takes it out of today’s sales',
    voided.status < 300 &&
      n(sB0.headline.sales.count) - n(sB1.headline.sales.count) === 1 &&
      near(n(sB0.headline.sales.total) - n(sB1.headline.sales.total), 150),
    {
      status: voided.status,
      before: sB0.headline.sales,
      after: sB1.headline.sales,
    },
  );
  ok(
    'B2 and counts it under voided (+1 / +150)',
    n(sB1.attention.voided?.count) - n(sB0.attention.voided?.count) === 1 &&
      near(
        n(sB1.attention.voided?.total) - n(sB0.attention.voided?.total),
        150,
      ),
    { before: sB0.attention.voided, after: sB1.attention.voided },
  );
  const voids = await entries(`?type=voided&limit=1000`);
  const voidRow = (voids?.items ?? []).find((i: any) => i.id === doomed?.id);
  ok(
    'B3 the voided filter lists it, by who voided it',
    !!voidRow && voidRow.status === 'void' && !!voidRow.createdBy,
    voidRow,
  );

  // ═══════════════════════════════════════════════════════════════
  // C. Comparisons
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— C. comparisons');
  const sY = await summary(`?date=${YESTERDAY}`);
  ok(
    'C1 previousDay is the day before’s own figure',
    sY?.date === YESTERDAY &&
      near(
        n(sB1.headline.sales.previousDay.total),
        n(sY.headline.sales.total),
      ) &&
      n(sB1.headline.sales.previousDay.count) === n(sY.headline.sales.count),
    {
      previousDay: sB1.headline.sales.previousDay,
      yesterday: sY?.headline?.sales,
    },
  );
  ok(
    'C2 the 7-day trend ends on today and covers the week',
    sB1.trendDates?.length === 7 &&
      sB1.trendDates[6] === TODAY &&
      near(sB1.headline.sales.trend[6], n(sB1.headline.sales.total)) &&
      near(sB1.headline.sales.trend[5], n(sY.headline.sales.total)),
    { dates: sB1.trendDates, trend: sB1.headline.sales.trend },
  );
  const bad = await req('GET', '/reports/day-summary?date=2026-02-30');
  ok(
    'C3 an impossible date is a coded 400',
    codeOf(bad) === 'INVALID_DATE',
    bad.body,
  );

  // ═══════════════════════════════════════════════════════════════
  // D. Staff see their own day
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— D. staff');
  const staffUser = `ds.staff.${RUN}`.toLowerCase();
  const created = await req('POST', '/settings/users', {
    name: `DS Staff ${RUN}`,
    username: staffUser,
    password: 'Test1234!',
    role: 'staff',
  });
  const staffId: string | undefined =
    data(created)?.id ?? data(created)?.user?.id ?? data(created)?.userId;
  const ST: string | undefined =
    created.status < 300
      ? data(
          await req(
            'POST',
            '/auth/signin',
            { email: staffUser, password: 'Test1234!' },
            '',
          ),
        )?.tokens?.accessToken
      : undefined;
  if (!ST) {
    console.log(
      `  (skipping D: no staff seat — ${created.status} ${codeOf(created) ?? ''})`,
    );
  } else {
    const st0 = await summary('', ST);
    ok(
      'D1 staff get their own view: no team, profit, voids or member list',
      st0?.scope?.ownOnly === true &&
        st0?.team === null &&
        st0?.profit === null &&
        st0?.attention?.voided === null &&
        st0?.members === null,
      { scope: st0?.scope, team: st0?.team, profit: st0?.profit },
    );
    ok(
      'D2 a new staff member’s day starts empty, whatever the owner sold',
      n(st0?.headline?.sales?.count) === 0 &&
        n(st0?.headline?.received?.count) === 0,
      st0?.headline,
    );
    const asked = data(await invoice(820, {}, ST));
    const approved = await req(
      'POST',
      `/approvals/${asked?.requestId}/decide`,
      {
        decision: 'approve',
      },
    );
    const st1 = await summary('', ST);
    ok(
      'D3 the invoice the owner approved for them is theirs (+1 / +820)',
      approved.status < 300 &&
        n(st1?.headline?.sales?.count) === 1 &&
        near(n(st1?.headline?.sales?.total), 820),
      { approved: approved.status, sales: st1?.headline?.sales },
    );
    const sD = await summary();
    const staffRow = (sD?.team ?? []).find((t: any) => t.userId === staffId);
    ok(
      'D4 the owner’s team table credits the staff member with it',
      !!staffRow &&
        n(staffRow.invoices.count) === 1 &&
        near(staffRow.invoices.total, 820),
      { staffId, team: sD?.team },
    );
    const asOne = staffId ? await summary(`?createdBy=${staffId}`) : null;
    ok(
      'D5 the owner can look at one person’s day',
      asOne?.scope?.createdBy?.id === staffId &&
        n(asOne?.headline?.sales?.count) === 1 &&
        asOne?.team === null,
      asOne?.scope,
    );
    const stEntries = await entries(`?limit=1000`, ST);
    ok(
      'D6 the staff Day Book holds only their own documents',
      (stEntries?.items ?? []).length >= 1 &&
        (stEntries?.items ?? []).every((i: any) => i.createdBy?.id === staffId),
      stEntries?.items?.map((i: any) => i.createdBy),
    );
    const stVoids = await entries(`?type=voided`, ST);
    ok('D7 staff are not shown voids', n(stVoids?.total) === 0, stVoids);
    const stSchedule = await req(
      'GET',
      '/reports/day-summary/schedule',
      undefined,
      ST,
    );
    ok(
      'D8 staff cannot read the digest schedule',
      stSchedule.status === 403,
      stSchedule.status,
    );
    const spoof = await summary(`?createdBy=${s1?.members?.[0]?.id ?? ''}`, ST);
    ok(
      'D9 staff asking for someone else still get their own day',
      spoof?.scope?.ownOnly === true && spoof?.scope?.createdBy?.id === staffId,
      spoof?.scope,
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // F. The Day Book at 50 or 100 a day: pages, totals, search, sort
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— F. Day Book paging, search and sort');
  const p1 = await entries(`?type=invoice&limit=2&page=1`);
  const p2 = await entries(`?type=invoice&limit=2&page=2`);
  const ids1 = [...ids(p1)];
  ok(
    'F1 pages hold different rows, with the same total and page count',
    (p1?.items ?? []).length === 2 &&
      (p2?.items ?? []).every((i: any) => !ids1.includes(i.id)) &&
      p1?.total === p2?.total &&
      p1?.pages === Math.ceil(n(p1?.total) / 2),
    { total: p1?.total, pages: p1?.pages, page2: p2?.items?.length },
  );
  const sF = await summary();
  ok(
    'F2 the counted total covers every page and equals the day’s sales',
    near(n(p1?.countedTotal), n(sF?.headline?.sales?.total)),
    { countedTotal: p1?.countedTotal, sales: sF?.headline?.sales?.total },
  );
  const beyond = await entries(`?type=invoice&limit=2&page=9999`);
  ok(
    'F3 a page past the end is empty but still knows the total',
    (beyond?.items ?? []).length === 0 && beyond?.total === p1?.total,
    { total: beyond?.total },
  );
  const found = await entries(`?q=${encodeURIComponent(sale.invoiceNumber)}`);
  ok(
    'F4 search finds a document by its number',
    ids(found).has(sale.id) &&
      (found?.items ?? []).every(
        (i: any) =>
          String(i.number ?? '').includes(sale.invoiceNumber) ||
          String(i.partyName ?? '')
            .toLowerCase()
            .includes(String(sale.invoiceNumber).toLowerCase()),
      ),
    { q: sale.invoiceNumber, total: found?.total },
  );
  const byParty = await entries(`?q=${encodeURIComponent(`Buyer ${RUN}`)}`);
  ok(
    'F5 …and by the customer’s name, case-insensitively',
    ids(byParty).has(sale.id) && ids(byParty).has(order.id),
    { total: byParty?.total },
  );
  const wild = await entries(`?q=${encodeURIComponent('%')}`);
  ok(
    'F6 a % is searched for literally, not as "anything"',
    n(wild?.total) === 0,
    wild?.total,
  );
  const big = await entries(`?sort=amount_desc&limit=1000`);
  const amounts = (big?.items ?? []).map((i: any) => n(i.amount));
  ok(
    'F7 sorting by amount, largest first',
    amounts.length > 1 &&
      amounts.every((a: number, k: number) => k === 0 || amounts[k - 1] >= a),
    amounts.slice(0, 5),
  );
  const old = await entries(`?sort=oldest&limit=1000`);
  ok(
    'F8 …and by entry time, oldest first',
    (old?.items ?? []).every(
      (i: any, k: number, arr: any[]) =>
        k === 0 || arr[k - 1].createdAt <= i.createdAt,
    ),
    old?.items?.slice(0, 3)?.map((i: any) => i.createdAt),
  );
  const badSort = await req('GET', '/reports/day-summary/entries?sort=random');
  const longQ = await req(
    'GET',
    `/reports/day-summary/entries?q=${'x'.repeat(101)}`,
  );
  ok(
    'F9 an unknown sort and an over-long search are coded 400s',
    codeOf(badSort) === 'INVALID_SORT' && codeOf(longQ) === 'INVALID_SEARCH',
    { sort: codeOf(badSort), q: codeOf(longQ) },
  );

  // ═══════════════════════════════════════════════════════════════
  // E. The digest
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— E. end-of-day digest');
  const before = data(await req('GET', '/reports/day-summary/schedule'));
  const put = await req('PUT', '/reports/day-summary/schedule', {
    enabled: true,
    hour: 13,
    email: true,
  });
  ok(
    'E1 the owner turns the digest on at 13:00',
    put.status < 300 && data(put)?.enabled === true && data(put)?.hour === 13,
    put.body,
  );
  const badHour = await req('PUT', '/reports/day-summary/schedule', {
    hour: 24,
  });
  ok('E2 an hour past 23 is refused', badHour.status === 400, badHour.status);

  if (process.env.DS_SKIP_CRON === 'true') {
    console.log('  (skipping the cron checks: DS_SKIP_CRON=true)');
  } else {
    const { NestFactory } = require('@nestjs/core');
    const { AppModule } = require('../src/app.module');
    const {
      DaySummaryCronService,
    } = require('../src/modules/reports/day-summary-cron.service');
    const app = await NestFactory.createApplicationContext(AppModule, {
      logger: ['error'],
    });
    try {
      const cron = app.get(DaySummaryCronService);
      const tz = data(put)?.timezone ?? 'Asia/Karachi';
      const at = (iso: string, hh: number) => {
        const [y, m, dd] = iso.split('-').map(Number);
        return zonedTimeToUtc(y, m, dd, hh, 30, tz);
      };
      const notes = async (day: string) =>
        n(
          (
            await sql(
              `SELECT count(*)::int AS c FROM notifications
                WHERE company_id = $1 AND type = 'day_summary'
                  AND data->>'date' = $2`,
              [COMPANY, day],
            )
          )[0]?.c,
        );
      await sql(
        `UPDATE company_settings SET day_summary_last_sent = NULL WHERE company_id = $1`,
        [COMPANY],
      );
      const early = await cron.runOnce(at(TODAY, 12), COMPANY);
      ok('E3 nothing goes out before the hour', early.sent === 0, early);
      const n0 = await notes(TODAY);
      const first = await cron.runOnce(at(TODAY, 14), COMPANY);
      const n1 = await notes(TODAY);
      ok(
        'E4 after 13:00 the day goes out: a notification for every owner',
        first.sent === 1 && n1 > n0,
        { first, before: n0, after: n1 },
      );
      const again = await cron.runOnce(at(TODAY, 15), COMPANY);
      ok(
        'E5 and only once',
        again.sent === 0 && (await notes(TODAY)) === n1,
        again,
      );

      await req('PUT', '/reports/day-summary/schedule', { hour: 8 });
      await sql(
        `UPDATE company_settings SET day_summary_last_sent = $2 WHERE company_id = $1`,
        [COMPANY, addDaysIso(TODAY, -2)],
      );
      const y0 = await notes(YESTERDAY);
      const morning = await cron.runOnce(at(TODAY, 9), COMPANY);
      ok(
        'E6 a morning digest (08:00) covers the day before',
        morning.sent === 1 && (await notes(YESTERDAY)) > y0,
        morning,
      );
    } finally {
      await app.close();
    }
  }
  // Leave the schedule as it was.
  await req('PUT', '/reports/day-summary/schedule', {
    enabled: !!before?.enabled,
    hour: n(before?.hour) || 21,
    email: before?.email !== false,
  });

  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('Failures:\n - ' + failures.join('\n - '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
