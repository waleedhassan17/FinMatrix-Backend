/**
 * FinMatrix — the invoice and bill lists, over HTTP.
 * ==========================================================================
 * GET /invoices and GET /bills are what the app and web lists page and search
 * through. This checks what only HTTP can show:
 *
 *   A. The summary and pagination reach the client beside `data` — the
 *      response envelope used to drop them, so lists counted only the page
 *      they held — and `data` is still the bare array every client reads.
 *   B. Overdue is derived from the due date: a sent invoice nobody has paid,
 *      past due, lists and opens as overdue; the status filter follows what is
 *      displayed ("overdue" includes it, "sent" leaves it out); the summary's
 *      counts, outstanding and overdue agree with the rows.
 *   C. Paging: page 2 continues page 1 with no gaps or repeats.
 *   D. Search reaches past the first page: an old invoice is found by number
 *      and by its customer's name.
 *   E. Bills follow the same rules.
 *
 * Usage: boot the API, then
 *   API_BASE=http://localhost:3000/api/v1 npx ts-node -r tsconfig-paths/register test/lists.acceptance.ts
 */
export {};

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';
const RUN = Date.now().toString().slice(-8);

const day = (offset: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail?: unknown) => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`,
    );
  }
};
const near = (a: number, b: number) => Math.abs(a - b) <= 0.005;
const n = (v: unknown) => Number(v ?? 0) || 0;

let TOKEN = '';
let COMPANY = '';
async function req(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (COMPANY) headers['x-company-id'] = COMPANY;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body: parsed };
}
const data = (r: { body: any }) => r.body?.data ?? r.body;

async function main() {
  console.log(`\nFinMatrix — invoice and bill lists → ${API}\n`);
  const login = await req('POST', '/auth/signin', {
    email: EMAIL,
    password: PASSWORD,
  });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  if (!TOKEN) throw new Error('cannot sign in');
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  const customer = data(
    await req('POST', '/customers', { name: `Lists Customer ${RUN}` }),
  );
  const invoice = async (
    label: string,
    invoiceDate: string,
    dueDate: string,
    price: number,
    status = 'sent',
  ) => {
    const r = await req('POST', '/invoices', {
      customerId: customer.id,
      invoiceDate,
      dueDate,
      status,
      lines: [
        {
          description: label,
          quantity: '1',
          unitPrice: String(price),
          taxRate: '0',
          lineKind: 'service',
        },
      ],
    });
    if (r.status >= 400)
      throw new Error(`invoice ${label}: ${JSON.stringify(r.body)}`);
    return data(r);
  };
  // Past due and unpaid; current; current and part-paid; a draft.
  const late = await invoice('late', day(-60), day(-30), 400);
  const current = await invoice('current', day(-5), day(25), 300);
  const part = await invoice('part', day(-4), day(26), 200);
  const draft = await invoice('draft', day(-3), day(27), 100, 'draft');
  const partPay = await req('POST', '/payments', {
    customerId: customer.id,
    paymentDate: day(0),
    paymentMethod: 'cash',
    amount: '50.00',
    applications: [{ invoiceId: part.id, amount: '50.00' }],
  });
  ok(
    'four invoices and a part-payment set up',
    partPay.status < 400,
    partPay.body,
  );

  // ── A. The envelope ───────────────────────────────────────────
  console.log('\n— A. summary and pagination reach the client');
  const all = await req('GET', `/invoices?customerId=${customer.id}`);
  ok(
    'A1 `data` is still the bare array of rows',
    Array.isArray(all.body?.data) && all.body.data.length === 4,
    all.body,
  );
  ok(
    'A2 the summary rides beside it',
    !!all.body?.summary && typeof all.body.summary.count === 'number',
  );
  ok(
    'A3 and the pagination',
    all.body?.pagination?.total === 4 && all.body?.pagination?.totalPages === 1,
    all.body?.pagination,
  );

  // ── B. Overdue, derived ───────────────────────────────────────
  console.log('\n— B. overdue is derived from the due date');
  const byId = Object.fromEntries(
    (all.body?.data ?? []).map((r: any) => [r.id, r]),
  );
  ok(
    'B1 the unpaid past-due invoice lists as overdue',
    byId[late.id]?.status === 'overdue',
    byId[late.id]?.status,
  );
  ok(
    'B2 current ones keep sent / partial; the draft stays draft',
    byId[current.id]?.status === 'sent' &&
      byId[part.id]?.status === 'partial' &&
      byId[draft.id]?.status === 'draft',
    [byId[current.id]?.status, byId[part.id]?.status, byId[draft.id]?.status],
  );
  const opened = data(await req('GET', `/invoices/${late.id}`));
  ok('B3 and opens as overdue', opened?.status === 'overdue', opened?.status);
  const overdueTab = await req(
    'GET',
    `/invoices?customerId=${customer.id}&status=overdue`,
  );
  ok(
    'B4 the overdue filter takes it',
    overdueTab.body?.data?.length === 1 &&
      overdueTab.body.data[0].id === late.id,
    overdueTab.body?.data?.map((r: any) => r.invoiceNumber),
  );
  const sentTab = await req(
    'GET',
    `/invoices?customerId=${customer.id}&status=sent`,
  );
  ok(
    'B5 the sent filter leaves it out',
    sentTab.body?.data?.length === 1 && sentTab.body.data[0].id === current.id,
    sentTab.body?.data?.map((r: any) => r.invoiceNumber),
  );
  const s = all.body?.summary ?? {};
  ok(
    'B6 counts by displayed status',
    s.count === 4 &&
      s.byStatus?.overdue?.count === 1 &&
      s.byStatus?.sent?.count === 1 &&
      s.byStatus?.partial?.count === 1 &&
      s.byStatus?.draft?.count === 1,
    s.byStatus,
  );
  ok(
    'B7 outstanding 400 + 300 + 150 = 850, overdue 400 — drafts owe nothing yet',
    near(n(s.outstanding), 850) && near(n(s.overdue), 400),
    { outstanding: s.outstanding, overdue: s.overdue },
  );
  ok(
    'B8 a status tab is a slice: the summary still counts every tab',
    overdueTab.body?.summary?.count === 4,
    overdueTab.body?.summary?.count,
  );

  // ── C. Paging ─────────────────────────────────────────────────
  console.log('\n— C. paging');
  const p1 = await req(
    'GET',
    `/invoices?customerId=${customer.id}&limit=3&page=1`,
  );
  const p2 = await req(
    'GET',
    `/invoices?customerId=${customer.id}&limit=3&page=2`,
  );
  const ids = [...(p1.body?.data ?? []), ...(p2.body?.data ?? [])].map(
    (r: any) => r.id,
  );
  ok(
    'C1 two pages of 3 hold all 4, each once',
    ids.length === 4 && new Set(ids).size === 4,
    ids.length,
  );
  ok(
    'C2 the pagination says so',
    p1.body?.pagination?.totalPages === 2 && p2.body?.pagination?.page === 2,
    p1.body?.pagination,
  );

  // ── D. Search past the first page ─────────────────────────────
  console.log('\n— D. search');
  const byNumber = await req(
    'GET',
    `/invoices?search=${encodeURIComponent(late.invoiceNumber)}&limit=5`,
  );
  ok(
    'D1 an invoice is found by its number, company-wide',
    (byNumber.body?.data ?? []).some((r: any) => r.id === late.id),
    byNumber.body?.data?.length,
  );
  const byName = await req(
    'GET',
    `/invoices?search=${encodeURIComponent(`Lists Customer ${RUN}`)}&limit=50`,
  );
  ok(
    "D2 and by its customer's name — all four, with a summary of just them",
    byName.body?.data?.length === 4 && byName.body?.summary?.count === 4,
    byName.body?.summary,
  );

  // ── E. Bills ──────────────────────────────────────────────────
  console.log('\n— E. bills');
  const vendor = data(
    await req('POST', '/vendors', { companyName: `Lists Vendor ${RUN}` }),
  );
  const bill = async (
    label: string,
    billDate: string,
    dueDate: string,
    amount: number,
  ) => {
    const r = await req('POST', '/bills', {
      vendorId: vendor.id,
      billNumber: `LST-${RUN}-${label}`,
      billDate,
      dueDate,
      status: 'open',
      lines: [{ description: label, amount: String(amount), taxRate: '0' }],
    });
    if (r.status >= 400)
      throw new Error(`bill ${label}: ${JSON.stringify(r.body)}`);
    return data(r);
  };
  const lateBill = await bill('LATE', day(-50), day(-20), 700);
  const dueBill = await bill('DUE', day(-2), day(28), 300);
  const bills = await req('GET', `/bills?vendorId=${vendor.id}`);
  ok(
    'E1 bills carry `data`, summary and pagination',
    Array.isArray(bills.body?.data) &&
      !!bills.body?.summary &&
      !!bills.body?.pagination,
  );
  const openTab = await req('GET', `/bills?vendorId=${vendor.id}&status=open`);
  ok(
    'E2 the open filter leaves out the bill that shows as overdue',
    openTab.body?.data?.length === 1 && openTab.body.data[0].id === dueBill.id,
    openTab.body?.data?.map((r: any) => r.billNumber),
  );
  const lateTab = await req(
    'GET',
    `/bills?vendorId=${vendor.id}&status=overdue`,
  );
  ok(
    'E3 the overdue filter takes it',
    lateTab.body?.data?.length === 1 && lateTab.body.data[0].id === lateBill.id,
    lateTab.body?.data?.map((r: any) => r.billNumber),
  );
  const bs = bills.body?.summary ?? {};
  ok(
    'E4 summary: 1000 outstanding, 700 of it overdue',
    near(n(bs.outstanding), 1000) &&
      near(n(bs.overdue), 700) &&
      bs.byStatus?.overdue?.count === 1 &&
      bs.byStatus?.open?.count === 1,
    bs,
  );
  const billSearch = await req(
    'GET',
    `/bills?search=${encodeURIComponent(`LST-${RUN}-LATE`)}`,
  );
  ok(
    'E5 a bill is found by its number',
    (billSearch.body?.data ?? []).some((r: any) => r.id === lateBill.id),
  );
  const opened2 = data(await req('GET', `/bills/${lateBill.id}`));
  ok(
    'E6 a bill opened on its own names its vendor, and shows as overdue',
    opened2?.vendorName === `Lists Vendor ${RUN}` && opened2?.status === 'overdue',
    { vendorName: opened2?.vendorName, status: opened2?.status },
  );

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
