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
 *   G. Item-wise sales: per item sold, free (price 0), returned, net units and
 *      net sales, cost and profit for the owner only, the tie to the day's
 *      invoices and returns, Best sellers from the same figures, reorder
 *      alerts, comparisons, ranges and their coded 400s.
 *   H. Purchasing: POs placed (not drafts, not withdrawn), goods received at
 *      cost, bills from POs, open, overdue and received-not-billed (the GRNI
 *      balance), the Day Book's drafts and cancelled filters, the team table,
 *      and staff credited with the POs an owner approved for them.
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
  // G. Item-wise sales: sold, free, returned, net units, net sales
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— G. item-wise sales');
  const sheet = async (q = '', token?: string) =>
    data(
      await req('GET', `/reports/day-summary/items${q}`, undefined, token),
    ) as any;
  const rowOf = (s: any, itemId: string) =>
    (s?.rows ?? []).find((r: any) => r.itemId === itemId);
  const newItem = async (
    tag: string,
    name: string,
    category: string | undefined,
    price: number,
    cost: number,
    reorderPoint: number,
  ) => {
    const made = data(
      await req('POST', '/inventory/items', {
        sku: `DS-${tag}-${RUN}`,
        name: `${name} ${RUN}`,
        ...(category ? { category } : {}),
        unitOfMeasure: 'tin',
        unitCost: String(cost),
        sellingPrice: String(price),
        reorderPoint: String(reorderPoint),
        reorderQuantity: '24',
      }),
    );
    const id: string | undefined = made?.id ?? made?.item?.id;
    if (id) {
      await req('POST', `/inventory/items/${id}/opening-stock`, {
        quantity: '20',
        asOfDate: TODAY,
      });
    }
    return id;
  };
  const tinA = await newItem(
    'A',
    'Lactogen 1 400G',
    'NESTLE POWDER',
    1500,
    1100,
    15,
  );
  const tinB = await newItem('B', 'Milkpak 1000ML', 'MILK PACK', 360, 300, 0);
  const tinC = await newItem('C', 'Loose Sundry', undefined, 100, 50, 0);
  ok('G0 three stock items with opening stock', !!tinA && !!tinB && !!tinC, {
    tinA,
    tinB,
    tinC,
  });

  const g0 = await sheet('?compare=previous');
  const sum0 = await summary();
  const itemLine = (itemId: string, qty: number, price: number) => ({
    description: `Item ${itemId.slice(0, 6)}`,
    quantity: String(qty),
    unitPrice: String(price),
    taxRate: '0',
    itemId,
    lineKind: 'item',
  });
  const soldInv = await req('POST', '/invoices', {
    customerId: customer.id,
    invoiceDate: TODAY,
    dueDate: TODAY,
    status: 'sent',
    lines: [
      itemLine(tinA!, 6, 1500),
      itemLine(tinA!, 1, 0), // one tin free
      itemLine(tinB!, 10, 360),
    ],
  });
  const discInv = await req('POST', '/invoices', {
    customerId: customer.id,
    invoiceDate: TODAY,
    dueDate: TODAY,
    status: 'sent',
    discountType: 'percent',
    discountValue: '10',
    lines: [itemLine(tinC!, 4, 100)],
  });
  const charge = data(await invoice(250));
  const ret = await req('POST', '/credit-memos', {
    customerId: customer.id,
    date: TODAY,
    reason: `Day summary return ${RUN}`,
    lines: [
      {
        description: 'Returned tins',
        quantity: '2',
        unitPrice: '1500',
        taxRate: '0',
        itemId: tinA,
      },
    ],
  });
  ok(
    'G1 the sale, the discounted sale, a charge and a return post',
    soldInv.status < 300 &&
      discInv.status < 300 &&
      !!charge?.id &&
      ret.status < 300,
    [soldInv.status, discInv.status, ret.status, codeOf(soldInv), codeOf(ret)],
  );

  const g1 = await sheet('?compare=previous');
  const a = rowOf(g1, tinA!);
  ok(
    'G2 Lactogen: 6 sold, 1 free, 2 returned → 5 net, Rs 6,000 net sales',
    a?.sold === 6 &&
      a?.free === 1 &&
      a?.returned === 2 &&
      a?.net === 5 &&
      near(a?.value, 6000) &&
      near(a?.returnsValue, 3000),
    a,
  );
  ok(
    'G3 the owner sees its cost (5 tins × 1,100) and profit; group and agency come with it',
    near(a?.cost, 5500) &&
      near(a?.profit, 500) &&
      a?.margin === 8.3 &&
      a?.category === 'NESTLE POWDER' &&
      a?.code === `DS-A-${RUN}` &&
      a?.unit === 'tin' &&
      g1?.showCost === true,
    a,
  );
  const b = rowOf(g1, tinB!);
  const c = rowOf(g1, tinC!);
  ok(
    'G4 Milkpak: 10 sold for Rs 3,600; the uncategorised item keeps only 90% after the invoice’s 10% discount',
    b?.sold === 10 &&
      near(b?.value, 3600) &&
      b?.category === 'MILK PACK' &&
      c?.sold === 4 &&
      near(c?.value, 360) &&
      c?.category === null,
    { b, c },
  );
  const svc = (g1?.rows ?? []).find(
    (r: any) => r.kind === 'service' && r.name === `Day summary line ${RUN}`,
  );
  ok(
    'G5 a line with no stock item is a service, named by its wording, with no cost of goods',
    !!svc &&
      svc.itemId === null &&
      n(svc.value) >= 250 &&
      svc.cost === null &&
      svc.profit === null,
    svc,
  );
  ok(
    'G6 the sheet grew by exactly these sales, and shows the Free column',
    near(
      n(g1?.totals?.value) - n(g0?.totals?.value),
      6000 + 3600 + 360 + 250,
    ) && g1?.hasFree === true,
    { before: g0?.totals, after: g1?.totals },
  );
  ok(
    'G7 net sales tie to the day’s invoices (before tax, after discounts) less its returns',
    g1?.reconciliation?.matches === true &&
      near(n(g1?.reconciliation?.netSales), n(g1?.totals?.value), 0.05),
    { reconciliation: g1?.reconciliation, total: g1?.totals?.value },
  );
  const sum1 = await summary();
  ok(
    'G8 the Money figures net the return: returns +3,000 and net = total − returns',
    near(n(sum1?.sales?.returns) - n(sum0?.sales?.returns), 3000) &&
      near(
        n(sum1?.sales?.net),
        n(sum1?.sales?.total) - n(sum1?.sales?.returns),
      ),
    sum1?.sales,
  );
  const disagree = (sum1?.topItems ?? []).filter((t: any) => {
    const r = (g1?.rows ?? []).find(
      (x: any) =>
        (t.itemId && x.itemId === t.itemId) ||
        (!t.itemId && !x.itemId && x.name === t.name),
    );
    return (
      !r || !near(n(r.value), n(t.total)) || !near(n(r.net), n(t.quantity))
    );
  });
  ok(
    'G9 Best sellers are the sheet’s own lines and figures',
    (sum1?.topItems ?? []).length > 0 && disagree.length === 0,
    { top: sum1?.topItems, disagree },
  );
  const alert = (g1?.reorder ?? []).find((r: any) => r.itemId === tinA);
  ok(
    'G10 Lactogen is at its reorder point (20 − 6 − 1 + 2 = 15 ≤ 15); Milkpak, with none set, is not',
    !!alert &&
      alert.onHand === 15 &&
      alert.reorderPoint === 15 &&
      alert.reorderQuantity === 24 &&
      alert.outOfStock === false &&
      !(g1?.reorder ?? []).some((r: any) => r.itemId === tinB),
    { alert, reorder: g1?.reorder },
  );
  ok(
    'G11 compared with yesterday: a new item compares with 0, and the period is the day before',
    g1?.compare === 'previous' &&
      g1?.compareFrom === YESTERDAY &&
      g1?.compareTo === YESTERDAY &&
      a?.compareValue === 0,
    { compare: g1?.compare, from: g1?.compareFrom, a: a?.compareValue },
  );
  const wk = await sheet('?compare=lastWeek');
  ok(
    'G12 compared with last week: the same day a week earlier',
    wk?.compareFrom === addDaysIso(TODAY, -7) &&
      wk?.compareTo === addDaysIso(TODAY, -7),
    { from: wk?.compareFrom, to: wk?.compareTo },
  );
  const range = await sheet(`?from=${YESTERDAY}&to=${TODAY}`);
  const yday = await sheet(`?date=${YESTERDAY}`);
  ok(
    'G13 a two-day range adds both days',
    range?.from === YESTERDAY &&
      range?.to === TODAY &&
      near(
        n(range?.totals?.value),
        n(g1?.totals?.value) + n(yday?.totals?.value),
      ) &&
      rowOf(range, tinA!)?.net === 5,
    { range: range?.totals, today: g1?.totals, yday: yday?.totals },
  );
  const [backwards, half, tooLong, badCompare] = await Promise.all([
    req('GET', `/reports/day-summary/items?from=${TODAY}&to=${YESTERDAY}`),
    req('GET', `/reports/day-summary/items?from=${TODAY}`),
    req(
      'GET',
      `/reports/day-summary/items?from=${addDaysIso(TODAY, -400)}&to=${TODAY}`,
    ),
    req('GET', '/reports/day-summary/items?compare=month'),
  ]);
  ok(
    'G14 a backwards, half or over-long range and an unknown comparison are coded 400s',
    codeOf(backwards) === 'INVALID_RANGE' &&
      codeOf(half) === 'INVALID_RANGE' &&
      codeOf(tooLong) === 'INVALID_RANGE' &&
      codeOf(badCompare) === 'INVALID_COMPARE',
    [codeOf(backwards), codeOf(half), codeOf(tooLong), codeOf(badCompare)],
  );
  if (ST) {
    const mine = await sheet('', ST);
    ok(
      'G15 staff see only the lines they sold, without cost or profit',
      mine?.scope?.ownOnly === true &&
        mine?.showCost === false &&
        !rowOf(mine, tinA!) &&
        (mine?.rows ?? []).every(
          (r: any) => r.cost === null && r.profit === null,
        ),
      { scope: mine?.scope, rows: (mine?.rows ?? []).slice(0, 3) },
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // H. Purchasing: placed, received, billed, open, overdue
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— H. purchasing');
  const hS0 = await summary();
  if (!hS0?.kinds?.includes('purchase_order')) {
    ok(
      'H0 a plan without purchase orders has no buying figures',
      hS0?.purchasing === null && hS0?.headline?.purchaseOrders === null,
      { purchasing: hS0?.purchasing, headline: hS0?.headline },
    );
  } else {
    const vendor = data(
      await req('POST', '/vendors', { companyName: `DS Supplier ${RUN}` }),
    );
    const stock = await newItem('P', 'Nido 400G', 'NESTLE POWDER', 450, 300, 0);
    ok('H0 a supplier and a stock item', !!vendor?.id && !!stock, {
      vendor: vendor?.id,
      stock,
    });
    const po = async (
      qty: number,
      extra: Record<string, unknown> = {},
      token?: string,
    ) =>
      data(
        await req(
          'POST',
          '/purchase-orders',
          {
            vendorId: vendor.id,
            orderDate: TODAY,
            lines: [
              {
                description: `Nido ${RUN}`,
                orderedQty: String(qty),
                unitCost: '300',
                taxRate: '0',
                lineKind: 'item',
                itemId: stock,
              },
            ],
            ...extra,
          },
          token,
        ),
      ) as any;
    const setStatus = (id: string, status: string, token?: string) =>
      req('PATCH', `/purchase-orders/${id}/status`, { status }, token);
    const receive = (order: any, qty: number, token?: string) =>
      req(
        'POST',
        `/purchase-orders/${order.id}/receive`,
        { lines: [{ lineId: order.lines[0].id, receivedQty: String(qty) }] },
        token,
      );
    const purchaseOrdersToday = (s: any) =>
      (s?.documents ?? []).find((x: any) => x.kind === 'purchase_order');
    const position = (s: any) => s?.purchasing?.position;

    const ownerTeam0 = (hS0?.team ?? []).reduce(
      (t: number, r: any) => t + n(r.purchaseOrders?.count),
      0,
    );
    const draftPo = await po(4);
    const sentPo = await po(10, { expectedDate: addDaysIso(TODAY, 3) });
    await setStatus(sentPo.id, 'sent');
    const withdrawnPo = await po(2);
    await setStatus(withdrawnPo.id, 'sent');
    const withdrew = await setStatus(withdrawnPo.id, 'closed');
    const latePo = await po(5, {
      orderDate: addDaysIso(TODAY, -5),
      expectedDate: addDaysIso(TODAY, -2),
    });
    await setStatus(latePo.id, 'sent');
    const partPo = await po(10, { expectedDate: addDaysIso(TODAY, 2) });
    await setStatus(partPo.id, 'sent');
    const got6 = await receive(partPo, 6);
    const billedRes = await req(
      'POST',
      `/purchase-orders/${partPo.id}/create-bill`,
      { billDate: TODAY, dueDate: TODAY },
    );
    const got8 = await receive(partPo, 8);
    ok(
      'H1 the purchase orders are raised, sent, withdrawn, received and billed',
      !!draftPo?.id &&
        !!sentPo?.id &&
        withdrew.status < 300 &&
        !!latePo?.id &&
        got6.status < 300 &&
        billedRes.status < 300 &&
        got8.status < 300,
      {
        withdrew: withdrew.body,
        got6: got6.body,
        billed: billedRes.body,
        got8: got8.body,
      },
    );
    const [creators] = [
      await sql(
        `SELECT count(*) FILTER (WHERE created_by IS NOT NULL)::int AS n
           FROM purchase_orders WHERE id = ANY($1::uuid[])`,
        [[draftPo.id, sentPo.id, partPo.id]],
      ),
    ];
    ok(
      'H2 a purchase order records who raised it',
      n(creators[0]?.n) === 3,
      creators,
    );

    const hS1 = await summary();
    const hd = (path: (s: any) => unknown) => n(path(hS1)) - n(path(hS0));
    ok(
      'H3 POs placed +2 / +6,000: not the draft, the withdrawn one or the back-dated one',
      hd((s) => s.headline.purchaseOrders.count) === 2 &&
        near(
          hd((s) => s.headline.purchaseOrders.total),
          6000,
        ) &&
        hd((s) => s.purchasing.placed.count) === 2 &&
        hd((s) => purchaseOrdersToday(s)?.count) === 2,
      {
        headline: [
          hS0?.headline?.purchaseOrders,
          hS1?.headline?.purchaseOrders,
        ],
      },
    );
    ok(
      'H4 goods received +2,400 at cost on 1 purchase order (6 then 2 more)',
      hd((s) => s.headline.goodsReceived.count) === 1 &&
        near(
          hd((s) => s.headline.goodsReceived.total),
          2400,
        ) &&
        near(
          hd((s) => s.purchasing.received.total),
          2400,
        ),
      [hS0?.headline?.goodsReceived, hS1?.headline?.goodsReceived],
    );
    const moved = await sql(
      `SELECT COALESCE(sum(value_change), 0)::float8 AS v
         FROM inventory_movements
        WHERE company_id = $1 AND type = 'receipt'
          AND source_type = 'purchase_order' AND date = $2`,
      [COMPANY, TODAY],
    );
    ok(
      'H5 goods received is the receipts’ stock value',
      near(n(hS1?.headline?.goodsReceived?.total), n(moved[0]?.v)),
      { summary: hS1?.headline?.goodsReceived?.total, movements: moved[0]?.v },
    );
    ok(
      'H6 billed from purchase orders +1 / +1,800',
      hd((s) => s.purchasing.billed.count) === 1 &&
        near(
          hd((s) => s.purchasing.billed.total),
          1800,
        ),
      [hS0?.purchasing?.billed, hS1?.purchasing?.billed],
    );
    const ourVendor = (hS1?.purchasing?.topVendors ?? []).find(
      (v: any) => v.id === vendor.id,
    );
    ok(
      'H7 the supplier is among the day’s top vendors (2 orders, 6,000)',
      !!ourVendor && ourVendor.count === 2 && near(ourVendor.total, 6000),
      hS1?.purchasing?.topVendors,
    );
    ok(
      'H8 the draft PO is a draft to look at, the withdrawn one a called-off order',
      hd((s) => s.attention.drafts) === 1 &&
        hd((s) => s.attention.cancelledOrders) === 1,
      [hS0?.attention, hS1?.attention],
    );
    ok(
      'H9 the late PO is back-dated, not today’s',
      hd((s) => s.attention.backdated) === 1,
      [hS0?.attention?.backdated, hS1?.attention?.backdated],
    );
    ok(
      'H10 open POs +3 / +5,100 still to arrive (sent 3,000 + late 1,500 + 2 left of the part-received 600)',
      hd((s) => position(s).open.count) === 3 &&
        near(
          hd((s) => position(s).open.total),
          5100,
        ),
      [position(hS0)?.open, position(hS1)?.open],
    );
    ok(
      'H11 overdue +1 / +1,500, with the oldest expected date',
      hd((s) => position(s).overdue.count) === 1 &&
        near(
          hd((s) => position(s).overdue.total),
          1500,
        ) &&
        !!position(hS1)?.overdue?.oldest &&
        position(hS1).overdue.oldest <= addDaysIso(TODAY, -2),
      [position(hS0)?.overdue, position(hS1)?.overdue],
    );
    const grni = await sql(
      `SELECT COALESCE(sum(l.grni_accrued - l.grni_cleared), 0)::float8 AS v
         FROM purchase_order_lines l
         JOIN purchase_orders x ON x.id = l.order_id
        WHERE x.company_id = $1 AND x.status <> 'draft'`,
      [COMPANY],
    );
    ok(
      'H12 received not billed +600 (2 units), and it is the GRNI balance',
      near(
        hd((s) => position(s).receivedNotBilled.total),
        600,
      ) && near(n(position(hS1)?.receivedNotBilled?.total), n(grni[0]?.v)),
      { position: position(hS1)?.receivedNotBilled, grni: grni[0]?.v },
    );
    const ownerTeam1 = (hS1?.team ?? []).reduce(
      (t: number, r: any) => t + n(r.purchaseOrders?.count),
      0,
    );
    const notRecorded = (hS1?.team ?? []).find((r: any) => r.userId === null);
    ok(
      'H13 the team table credits the 2 placed POs to a person',
      ownerTeam1 - ownerTeam0 === 2 &&
        n(notRecorded?.purchaseOrders?.count) ===
          n(
            (hS0?.team ?? []).find((r: any) => r.userId === null)
              ?.purchaseOrders?.count,
          ),
      hS1?.team?.map((r: any) => [r.name, r.purchaseOrders]),
    );
    const drafts = await entries(`?type=drafts&limit=1000`);
    const calledOff = await entries(`?type=cancelled&limit=1000`);
    const poBook = await entries(`?type=purchase_order&limit=1000`);
    const inBook = (page: any, id: string) =>
      (page?.items ?? []).find((i: any) => i.id === id);
    ok(
      'H14 the Day Book: the draft under Drafts, the withdrawn PO under Cancelled as “withdrawn”, every PO dated today under POs',
      !!inBook(drafts, draftPo.id) &&
        inBook(calledOff, withdrawnPo.id)?.status === 'withdrawn' &&
        !!inBook(poBook, sentPo.id) &&
        !!inBook(poBook, partPo.id) &&
        !!inBook(poBook, draftPo.id) &&
        !inBook(poBook, latePo.id),
      {
        drafts: drafts?.items?.length,
        cancelled: inBook(calledOff, withdrawnPo.id),
      },
    );

    if (ST && staffId) {
      const stH0 = await summary('', ST);
      const asked = await po(3, {}, ST);
      const approvedPo = await req(
        'POST',
        `/approvals/${asked?.requestId}/decide`,
        { decision: 'approve' },
      );
      const madeId: string | undefined =
        data(approvedPo)?.resultId ??
        (
          await sql(`SELECT result_id FROM approval_requests WHERE id = $1`, [
            asked?.requestId,
          ])
        )[0]?.result_id;
      const made = madeId
        ? (data(await req('GET', `/purchase-orders/${madeId}`)) as any)
        : null;
      if (made?.id) {
        await setStatus(made.id, 'sent', ST);
        await receive(made, 2, ST);
      }
      const stH1 = await summary('', ST);
      ok(
        'H15 the PO the owner approved is the staff member’s: placed +1 / +900, received +600',
        approvedPo.status < 300 &&
          n(stH1?.headline?.purchaseOrders?.count) -
            n(stH0?.headline?.purchaseOrders?.count) ===
            1 &&
          near(
            n(stH1?.headline?.purchaseOrders?.total) -
              n(stH0?.headline?.purchaseOrders?.total),
            900,
          ) &&
          near(
            n(stH1?.headline?.goodsReceived?.total) -
              n(stH0?.headline?.goodsReceived?.total),
            600,
          ),
        {
          approved: approvedPo.status,
          made: made?.id,
          before: stH0?.headline?.purchaseOrders,
          after: stH1?.headline?.purchaseOrders,
          received: stH1?.headline?.goodsReceived,
        },
      );
      ok(
        'H16 staff get the day’s buying but not the company’s position',
        stH1?.purchasing !== null && stH1?.purchasing?.position === null,
        stH1?.purchasing,
      );
      const hS2 = await summary();
      const staffTeam = (hS2?.team ?? []).find(
        (r: any) => r.userId === staffId,
      );
      ok(
        'H17 the owner’s team table shows the staff member’s PO',
        n(staffTeam?.purchaseOrders?.count) >= 1,
        staffTeam,
      );
    }
  }

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
