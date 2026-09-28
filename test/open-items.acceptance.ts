/**
 * FinMatrix — outstanding-invoices and payables summaries, end to end.
 * ====================================================================
 * GET /reports/ar-aging/customers/:id/summary is what a business sends a
 * customer as "here is everything you still owe us"; its A/P twin is the
 * payables summary for a vendor. A document that leaves the building has to be
 * right, so this drives both through the real API on real books:
 *
 *   A. Only open documents appear: a draft, a voided invoice and a fully paid
 *      one are absent; a part-paid one shows what is left.
 *   B. The figures are the customer's A/R aging row — total and every bucket —
 *      and the aging drill-down's total.
 *   C. An unapplied receipt and an open credit memo come off what is due.
 *   D. The vendor side: open bills only, the A/P aging row, a vendor credit
 *      netted.
 *   E. Refusals: an unknown party is 404, a malformed id 400, a rider 403 —
 *      and a rider can read neither the customer nor the vendor list, one
 *      record, a statement, or either through search.
 *
 * Each run makes its own customer and vendor, so it holds on books that
 * already contain data.
 *
 * Usage: boot the API, then
 *   API_BASE=http://localhost:3000/api/v1 \
 *   DATABASE_URL=postgres://... \
 *   npx ts-node -r tsconfig-paths/register test/open-items.acceptance.ts
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';
const RUN = Date.now().toString().slice(-8);

/** A calendar date `offset` days from today, in the business zone. */
const day = (offset: number): string => {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Karachi' }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const TODAY = day(0);

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
    console.log(`  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`);
  }
};
const near = (a: number, b: number, tol = 0.005) => Math.abs(a - b) <= tol;
const n = (v: unknown) => Number(v ?? 0) || 0;

let TOKEN = '';
let COMPANY = '';

async function req(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
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
const codeOf = (r: { body: any }) => r.body?.error?.code ?? r.body?.code;

async function main() {
  if (!DB) throw new Error('DATABASE_URL is required');
  const db = new Client({ connectionString: DB });
  await db.connect();

  console.log(`\nFinMatrix — outstanding and payables summaries → ${API}\n`);

  const login = await req('POST', '/auth/signin', { email: EMAIL, password: PASSWORD });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  ok('admin signs in', !!TOKEN && !!COMPANY, login.status);
  if (!TOKEN) throw new Error('cannot sign in');

  // Back-dated documents must be allowed on these books.
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  // ═══════════════════════════════════════════════════════════════
  // A–C. Customer
  // ═══════════════════════════════════════════════════════════════
  console.log('— A. only open invoices, each with what is left on it');

  const customer = data(
    await req('POST', '/customers', {
      name: `Summary Customer ${RUN}`,
      email: `summary.${RUN}@example.test`,
      phone: '0300 1234567',
      billingAddress: { street: '12 Mall Road', city: 'Lahore', country: 'Pakistan' },
      paymentTerms: 'net30',
    }),
  );
  ok('customer created', !!customer?.id, customer);

  const invoice = async (
    label: string,
    invoiceDate: string,
    dueDate: string,
    price: number,
    status: 'sent' | 'draft' = 'sent',
  ) => {
    const res = await req('POST', '/invoices', {
      customerId: customer.id,
      invoiceDate,
      dueDate,
      status,
      lines: [{ description: label, quantity: '1', unitPrice: String(price), taxRate: '0', lineKind: 'service' }],
    });
    ok(`invoice "${label}" created`, res.status < 400 && !!data(res)?.id, res.body);
    return data(res);
  };
  /** No applications means an advance: held on account, not swept onto invoices. */
  const receive = async (amount: number, applications: Array<{ invoiceId: string; amount: number }>) => {
    const res = await req('POST', '/payments', {
      customerId: customer.id,
      paymentDate: TODAY,
      paymentMethod: 'cash',
      amount: amount.toFixed(2),
      ...(applications.length > 0
        ? { applications: applications.map((a) => ({ invoiceId: a.invoiceId, amount: a.amount.toFixed(2) })) }
        : { holdAsAdvance: true }),
    });
    ok(`receipt of ${amount} recorded`, res.status < 400 && !!data(res)?.id, res.body);
    return data(res);
  };

  const overdue = await invoice('Overdue', day(-75), day(-45), 1000);
  const partPaid = await invoice('Part paid', day(-10), day(20), 500);
  const draft = await invoice('Draft', TODAY, day(30), 400, 'draft');
  const voided = await invoice('Voided', day(-5), day(25), 600);
  const settled = await invoice('Settled', day(-3), day(27), 350);

  const voidRes = await req('POST', `/invoices/${voided.id}/void`, { reason: 'acceptance' });
  ok('the voided invoice is void', voidRes.status < 400, voidRes.body);

  await receive(200, [{ invoiceId: partPaid.id, amount: 200 }]);
  await receive(350, [{ invoiceId: settled.id, amount: 350 }]);

  const cmRes = await req('POST', '/credit-memos', {
    customerId: customer.id,
    date: TODAY,
    reason: 'summary acceptance',
    lines: [{ description: 'Goodwill credit', quantity: '1', unitPrice: '150', taxRate: '0' }],
  });
  ok('credit memo created', cmRes.status < 400 && !!data(cmRes)?.id, cmRes.body);
  // Last, so it is the latest payment. Applied to nothing: an advance.
  const advance = await receive(250, []);

  const sumRes = await req('GET', `/reports/ar-aging/customers/${customer.id}/summary`);
  const summary = data(sumRes) as any;
  ok('A1 the summary answers 200', sumRes.status === 200, sumRes.body);
  ok('A2 it is not flattened by the envelope', Array.isArray(summary?.documents) && !!summary?.totals, Object.keys(summary ?? {}));

  const numbers = (summary?.documents ?? []).map((d: any) => d.documentId);
  ok('A3 exactly the two open invoices', numbers.length === 2 && numbers.includes(overdue.id) && numbers.includes(partPaid.id), numbers);
  ok('A4 the draft, the void and the settled invoice are absent',
    ![draft.id, voided.id, settled.id].some((id) => numbers.includes(id)));
  const part = summary.documents.find((d: any) => d.documentId === partPaid.id);
  ok('A5 the part-paid invoice shows total, paid and what is left',
    near(n(part?.total), 500) && near(n(part?.amountPaid), 200) && near(n(part?.balance), 300), part);
  ok('A6 not yet due reads as negative days, in the current bucket',
    part?.daysOverdue < 0 && part?.bucketKey === 'current', part);
  const late = summary.documents.find((d: any) => d.documentId === overdue.id);
  ok('A7 the overdue invoice is 45 days late', late?.daysOverdue === 45, late);
  ok('A8 soonest due first', summary.documents[0]?.documentId === overdue.id);

  ok('A9 totals', near(summary.totals.outstanding, 1300) && near(summary.totals.overdue, 1000)
    && summary.totals.overdueCount === 1 && near(summary.totals.notYetDue, 300) && summary.totals.count === 2,
  summary.totals);
  ok('A10 the party block carries what a sent document needs',
    summary.party?.name === customer.name && summary.party?.phone === customer.phone
      && summary.party?.email === customer.email && summary.party?.address === '12 Mall Road, Lahore, Pakistan'
      && summary.party?.paymentTerms === 'net30',
    summary.party);

  console.log('\n— B. the summary is the customer\'s aging row');
  const aging = data(await req('GET', '/reports/ar-aging')) as any;
  const row = (aging?.rows ?? []).find((r: any) => r.customerId === customer.id);
  ok('B1 outstanding equals the A/R aging row total', near(n(row?.total), summary.totals.outstanding), { row: row?.total });
  ok('B2 every bucket equals the row, and the buckets are the report\'s',
    summary.buckets.length === aging.buckets.length
      && summary.buckets.every((b: any, i: number) =>
        b.key === aging.buckets[i].key && near(b.amount, n(row?.amounts?.[b.key]))),
    { summary: summary.buckets, row: row?.amounts });
  ok('B3 bucket counts add up to the documents',
    summary.buckets.reduce((t: number, b: any) => t + b.count, 0) === summary.documents.length);
  const drill = data(await req('GET', `/reports/ar-aging/customers/${customer.id}/documents`)) as any;
  ok('B4 and equals the aging drill-down', near(n(drill?.outstandingTotal), summary.totals.outstanding), drill?.outstandingTotal);

  console.log('\n— C. money on account comes off what is due');
  const kinds = (summary.credits?.items ?? []).map((c: any) => `${c.kind}:${n(c.available)}`).sort();
  ok('C1 the unapplied receipt and the credit memo are listed', JSON.stringify(kinds) === JSON.stringify(['credit_memo:150', 'payment:250']), summary.credits);
  ok('C2 credits total 400', near(summary.credits.total, 400), summary.credits.total);
  ok('C3 net due is 900', near(summary.netDue, 900), summary.netDue);
  ok('C4 the latest payment is the advance',
    near(n(summary.lastPayment?.amount), 250) && summary.lastPayment?.date === TODAY
      && summary.lastPayment?.reference === advance?.paymentNumber,
    summary.lastPayment);

  // ═══════════════════════════════════════════════════════════════
  // D. Vendor
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— D. payables: open bills only, the A/P row, vendor credits netted');
  const vendor = data(
    await req('POST', '/vendors', { companyName: `Summary Vendor ${RUN}`, phone: '042 35761234' }),
  );
  ok('vendor created', !!vendor?.id, vendor);
  const bill = async (label: string, billDate: string, dueDate: string, amount: number, status: 'open' | 'draft' = 'open') => {
    const res = await req('POST', '/bills', {
      vendorId: vendor.id,
      billNumber: `SUM-${RUN}-${label}`,
      billDate,
      dueDate,
      status,
      lines: [{ description: label, amount: String(amount), taxRate: '0' }],
    });
    ok(`bill "${label}" created`, res.status < 400 && !!data(res)?.id, res.body);
    return data(res);
  };
  const lateBill = await bill('LATE', day(-40), day(-35), 700);
  const dueBill = await bill('DUE', day(-2), day(28), 300);
  const draftBill = await bill('DRAFT', TODAY, day(30), 900, 'draft');
  const vcRes = await req('POST', '/vendor-credits', {
    vendorId: vendor.id,
    date: TODAY,
    reason: 'summary acceptance',
    lines: [{ description: 'Returned goods', amount: '120', taxRate: '0' }],
  });
  ok('vendor credit created', vcRes.status < 400 && !!data(vcRes)?.id, vcRes.body);

  const apRes = await req('GET', `/reports/ap-aging/vendors/${vendor.id}/summary`);
  const payables = data(apRes) as any;
  ok('D1 the payables summary answers 200', apRes.status === 200, apRes.body);
  const billIds = (payables?.documents ?? []).map((d: any) => d.documentId);
  ok('D2 exactly the two open bills, the draft absent',
    billIds.length === 2 && billIds.includes(lateBill.id) && billIds.includes(dueBill.id) && !billIds.includes(draftBill.id), billIds);
  ok('D3 documents are bills', payables.documents.every((d: any) => d.documentType === 'bill'));
  ok('D4 totals', near(payables.totals.outstanding, 1000) && near(payables.totals.overdue, 700)
    && payables.totals.overdueCount === 1, payables.totals);
  const apAging = data(await req('GET', '/reports/ap-aging')) as any;
  const apRow = (apAging?.rows ?? []).find((r: any) => r.customerId === vendor.id);
  ok('D5 outstanding equals the A/P aging row', near(n(apRow?.total), payables.totals.outstanding), apRow?.total);
  ok('D6 the vendor credit comes off: net due 880',
    near(payables.credits.total, 120) && payables.credits.items[0]?.kind === 'vendor_credit' && near(payables.netDue, 880),
    payables.credits);
  ok('D7 no payment yet reads as none', payables.lastPayment === null, payables.lastPayment);
  ok('D8 vendor party details', payables.partyType === 'vendor' && payables.party?.name === vendor.companyName
    && payables.party?.phone === vendor.phone, payables.party);

  // ═══════════════════════════════════════════════════════════════
  // E. Refusals
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— E. refusals');
  const ghost = '00000000-0000-4000-8000-000000000000';
  const noCustomer = await req('GET', `/reports/ar-aging/customers/${ghost}/summary`);
  ok('E1 an unknown customer is 404 CUSTOMER_NOT_FOUND', noCustomer.status === 404 && codeOf(noCustomer) === 'CUSTOMER_NOT_FOUND', noCustomer.body);
  const noVendor = await req('GET', `/reports/ap-aging/vendors/${ghost}/summary`);
  ok('E2 an unknown vendor is 404 VENDOR_NOT_FOUND', noVendor.status === 404 && codeOf(noVendor) === 'VENDOR_NOT_FOUND', noVendor.body);
  const malformed = await req('GET', '/reports/ar-aging/customers/not-a-uuid/summary');
  ok('E3 a malformed id is 400', malformed.status === 400, malformed.status);

  // A rider of this company, reused across runs (seats are capped by plan).
  const RIDER_PASSWORD = 'Rider@123';
  const { rows: riders } = await db.query(
    `SELECT username FROM users
      WHERE role = 'delivery' AND username LIKE 'rpt.rider.%' AND default_company_id = $1
      ORDER BY created_at LIMIT 1`,
    [COMPANY],
  );
  let riderUsername: string = riders[0]?.username ?? '';
  if (!riderUsername) {
    riderUsername = `rpt.rider.${RUN}`;
    await req('POST', '/delivery-personnel', {
      username: riderUsername,
      password: RIDER_PASSWORD,
      name: `Reports Rider ${RUN}`,
      email: `rpt_rider_${RUN}@qa.local`,
    });
  }
  const riderLogin = await req('POST', '/auth/signin', { email: riderUsername, password: RIDER_PASSWORD });
  const riderToken = data(riderLogin)?.tokens?.accessToken ?? '';
  ok('rider signs in', !!riderToken, riderLogin.status);
  const asRider = await req('GET', `/reports/ar-aging/customers/${customer.id}/summary`, undefined, riderToken);
  ok('E4 a rider is refused (403)', asRider.status === 403, asRider.status);
  const asRiderAp = await req('GET', `/reports/ap-aging/vendors/${vendor.id}/summary`, undefined, riderToken);
  ok('E5 on the payables side too', asRiderAp.status === 403, asRiderAp.status);

  // Riders may not read the customer or vendor lists at all — not by the
  // lists, not one record at a time, and not through search.
  for (const [label, path] of [
    ['E6 a rider cannot list customers', '/customers'],
    ['E7 a rider cannot open a customer', `/customers/${customer.id}`],
    ['E8 a rider cannot read a customer statement', `/customers/${customer.id}/statement?startDate=2026-01-01&endDate=${TODAY}`],
    ['E9 a rider cannot list vendors', '/vendors'],
    ['E10 a rider cannot open a vendor', `/vendors/${vendor.id}`],
  ] as const) {
    const r = await req('GET', path, undefined, riderToken);
    ok(`${label} (403)`, r.status === 403, r.status);
  }
  const riderSearch = data(await req('GET', `/search?q=${encodeURIComponent('Summary')}`, undefined, riderToken)) as any;
  const leaked = ['customers', 'vendors', 'invoices', 'bills'].filter((k) => (riderSearch?.results?.[k] ?? []).length > 0);
  ok('E11 a rider\'s search names no customer or vendor', leaked.length === 0, { leaked, results: riderSearch?.results });
  const ownerList = await req('GET', '/customers');
  const ownerVendors = await req('GET', '/vendors');
  ok('E12 the owner still reads both lists', ownerList.status === 200 && ownerVendors.status === 200, [ownerList.status, ownerVendors.status]);

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
