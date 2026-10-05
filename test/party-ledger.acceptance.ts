/**
 * FinMatrix — customer and vendor IDs, their view in the General Ledger, the
 * statement read from it, paying against the outstanding summary, and History.
 * ===========================================================================
 *
 *   A. IDs: a new customer gets the next C-NNNN; a typed ID is kept
 *      upper-cased; a taken one is refused by name; lists find by ID, exact
 *      match first, and in ID order; invoices are found by their customer's ID.
 *   B. Paying a summary: three invoices (30, 20 and 50 lakh), one receipt of
 *      60 lakh applied 30 / 20 / 10 — the first two paid, the third part paid
 *      with 40 lakh left; the summary's net due is 40 lakh.
 *   C. The General Ledger by customer: the receipt is one credit of 60 lakh,
 *      the closing balance is the summary's net due and the statement's
 *      closing; a void shows on its own date beside the invoice it reverses;
 *      every customer together plus what no customer holds is the book's
 *      1100 + 2400.
 *   D. The vendor twin: bills, a part payment, a vendor credit; the ledger,
 *      statement and payables summary agree; every vendor ties to 2000.
 *   E. History: the months add up to the closing balance; an edit to the
 *      credit limit is logged by name, a re-save that changes nothing is not;
 *      the account view of the ledger answers as it always has.
 *   F. Refusals: a malformed party, a rider on every new route.
 *
 * Each run makes its own customer and vendor, so it holds on books that
 * already contain data.
 *
 * Usage: boot the API, then
 *   API_BASE=http://localhost:3000/api/v1 \
 *   DATABASE_URL=postgres://... \
 *   npx ts-node -r tsconfig-paths/register test/party-ledger.acceptance.ts
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';
const RUN = Date.now().toString().slice(-8);
const LAKH = 100_000;

/** A calendar date `offset` days from today, in the business zone. */
const day = (offset: number): string => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
  }).format(new Date());
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
};
const TODAY = day(0);
const YEAR_START = `${TODAY.slice(0, 4)}-01-01`;

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
const near = (a: number, b: number, tol = 0.005) => Math.abs(a - b) <= tol;
const n = (v: unknown) => Number(v ?? 0) || 0;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

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
      const ms = path.startsWith('/auth') ? 65_000 : 15_000 * (attempt + 1);
      console.log(
        `    (throttled on ${path} — waiting ${Math.round(ms / 1000)}s)`,
      );
      await wait(ms);
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
/** The rows of a customer/vendor list: `{data: {data, pagination}}` after the envelope. */
const rowsOf = (r: { body: any }): any[] => data(r)?.data ?? [];

async function main() {
  if (!DB) throw new Error('DATABASE_URL is required');
  const db = new Client({ connectionString: DB });
  await db.connect();
  const gl = async (accounts: string[]) => {
    const { rows } = await db.query(
      `SELECT COALESCE(ROUND(SUM(g.debit - g.credit)::numeric, 2), 0) AS v
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id = $1 AND a.account_number = ANY($2::text[]) AND g.date <= $3`,
      [COMPANY, accounts, TODAY],
    );
    return n(rows[0]?.v);
  };

  console.log(
    `\nFinMatrix — party IDs, ledger, statement, summary payment, history → ${API}\n`,
  );

  const login = await req('POST', '/auth/signin', {
    email: EMAIL,
    password: PASSWORD,
  });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  ok('admin signs in', !!TOKEN && !!COMPANY, login.status);
  if (!TOKEN) throw new Error('cannot sign in');
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  // ═══════════════════════════════════════════════════════════════
  console.log('— A. customer IDs');
  const suggested = data(await req('GET', '/customers/next-code'))
    ?.code as string;
  ok(
    'A1 the next ID is suggested in the series',
    /^C-\d{4,}$/.test(suggested ?? ''),
    suggested,
  );

  const customer = data(
    await req('POST', '/customers', {
      name: `Ledger Customer ${RUN}`,
      creditLimit: '0',
      paymentTerms: 'net30',
    }),
  );
  ok(
    'A2 a new customer gets the next ID',
    /^C-\d{4,}$/.test(customer?.code ?? ''),
    customer?.code,
  );

  const typedCode = `LC-${RUN}`;
  const typed = await req('POST', '/customers', {
    name: `Typed Customer ${RUN}`,
    code: ` ${typedCode.toLowerCase()} `,
  });
  ok(
    'A3 a typed ID is kept, upper-cased and trimmed',
    data(typed)?.code === typedCode,
    data(typed)?.code,
  );
  const taken = await req('POST', '/customers', {
    name: `Clash ${RUN}`,
    code: typedCode,
  });
  ok(
    'A4 a taken ID is refused by name (409 CUSTOMER_CODE_TAKEN)',
    taken.status === 409 &&
      codeOf(taken) === 'CUSTOMER_CODE_TAKEN' &&
      String(taken.body?.error?.message ?? '').includes(
        `Typed Customer ${RUN}`,
      ),
    taken.body,
  );
  const bad = await req('POST', '/customers', {
    name: `Bad ${RUN}`,
    code: 'A B',
  });
  ok(
    'A5 an ID with a space is refused (400 INVALID_CUSTOMER_CODE)',
    bad.status === 400 && codeOf(bad) === 'INVALID_CUSTOMER_CODE',
    bad.body,
  );

  const found = rowsOf(
    await req(
      'GET',
      `/customers?search=${encodeURIComponent(customer.code.toLowerCase())}`,
    ),
  );
  ok(
    'A6 the list finds a customer by ID, exact match first',
    found[0]?.id === customer.id,
    found.map((c) => c.code),
  );
  const ordered = rowsOf(await req('GET', '/customers?sort=code&limit=200'))
    .map((c) => c.code)
    .filter((c: string | null) => /^C-\d+$/.test(c ?? ''));
  const numbers = ordered.map((c: string) => parseInt(c.slice(2), 10));
  ok(
    'A7 ID order is natural (C-2 before C-10)',
    numbers.every((v: number, i: number) => i === 0 || numbers[i - 1] < v),
    ordered.slice(0, 12),
  );

  // ═══════════════════════════════════════════════════════════════
  console.log(
    '\n— B. one receipt against the outstanding summary: 30 + 20 in full, 10 on the third',
  );
  const invoice = async (
    label: string,
    invoiceDate: string,
    dueDate: string,
    price: number,
  ) => {
    const res = await req('POST', '/invoices', {
      customerId: customer.id,
      invoiceDate,
      dueDate,
      status: 'sent',
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
    ok(
      `invoice "${label}" created`,
      res.status < 400 && !!data(res)?.id,
      res.body,
    );
    return data(res);
  };
  const inv30 = await invoice('Thirty lakh', day(-60), day(-30), 30 * LAKH);
  const inv20 = await invoice('Twenty lakh', day(-40), day(-10), 20 * LAKH);
  const inv50 = await invoice('Fifty lakh', day(-20), day(10), 50 * LAKH);

  const before = data(
    await req('GET', `/reports/ar-aging/customers/${customer.id}/summary`),
  ) as any;
  ok(
    'B1 the summary is one crore',
    near(n(before?.netDue), 100 * LAKH),
    before?.netDue,
  );
  ok(
    'B2 the summary carries the customer ID',
    before?.party?.code === customer.code,
    before?.party,
  );
  ok(
    'B3 its invoices are oldest-due first, as the server applies a receipt',
    (before?.documents ?? []).map((d: any) => d.documentId).join() ===
      [inv30.id, inv20.id, inv50.id].join(),
  );

  const receipt = await req('POST', '/payments', {
    customerId: customer.id,
    paymentDate: TODAY,
    paymentMethod: 'bank_transfer',
    amount: (60 * LAKH).toFixed(2),
    applications: [
      { invoiceId: inv30.id, amount: (30 * LAKH).toFixed(2) },
      { invoiceId: inv20.id, amount: (20 * LAKH).toFixed(2) },
      { invoiceId: inv50.id, amount: (10 * LAKH).toFixed(2) },
    ],
  });
  ok(
    'B4 one receipt of 60 lakh recorded',
    receipt.status < 400 && !!data(receipt)?.id,
    receipt.body,
  );
  const status = async (id: string) =>
    data(await req('GET', `/invoices/${id}`)) as any;
  const [a30, a20, a50] = await Promise.all([
    status(inv30.id),
    status(inv20.id),
    status(inv50.id),
  ]);
  ok(
    'B5 the 30 and 20 lakh invoices are paid',
    a30?.status === 'paid' && a20?.status === 'paid',
    [a30?.status, a20?.status],
  );
  ok(
    'B6 the 50 lakh invoice is part paid with 40 lakh left',
    a50?.status === 'partial' && near(n(a50?.balance), 40 * LAKH),
    [a50?.status, a50?.balance],
  );
  const after = data(
    await req('GET', `/reports/ar-aging/customers/${customer.id}/summary`),
  ) as any;
  ok(
    'B7 the summary now asks for 40 lakh',
    near(n(after?.netDue), 40 * LAKH),
    after?.netDue,
  );

  // ═══════════════════════════════════════════════════════════════
  console.log('\n— C. the General Ledger, by customer');
  const voided = await invoice('Voided later', day(-15), day(15), 700);
  const voidRes = await req('POST', `/invoices/${voided.id}/void`, {
    reason: 'party ledger acceptance',
  });
  ok('an invoice voided', voidRes.status < 400, voidRes.body);

  const led = data(
    await req(
      'GET',
      `/ledger?party=customer&partyId=${customer.id}&startDate=${YEAR_START}&endDate=${TODAY}`,
    ),
  ) as any;
  ok(
    "C1 the ledger answers in the account view's shape",
    Array.isArray(led?.entries) &&
      !!led?.totals &&
      Array.isArray(led?.closingBalances),
    Object.keys(led ?? {}),
  );
  const receiptLines = (led?.entries ?? []).filter(
    (e: any) => e.postingType === 'payment',
  );
  ok(
    'C2 the receipt is a credit of 60 lakh on A/R, named by its number',
    receiptLines.length === 1 &&
      near(n(receiptLines[0].credit), 60 * LAKH) &&
      receiptLines[0].documentNumber === data(receipt)?.paymentNumber &&
      receiptLines[0].label === 'Receipt',
    receiptLines,
  );
  const closing = n(led?.closingBalances?.[0]?.balance);
  ok(
    "C3 the closing balance is the summary's net due (40 lakh)",
    near(closing, 40 * LAKH),
    closing,
  );
  const voidLines = (led?.entries ?? []).filter(
    (e: any) => e.documentId === voided.id,
  );
  ok(
    'C4 the void shows on its own date beside the invoice it reverses',
    voidLines.length === 2 &&
      voidLines.some(
        (e: any) => e.postingType === 'invoice' && near(n(e.debit), 700),
      ) &&
      voidLines.some(
        (e: any) =>
          e.postingType === 'invoice_void' &&
          near(n(e.credit), 700) &&
          e.date === TODAY,
      ),
    voidLines.map((e: any) => [e.postingType, e.date, e.debit, e.credit]),
  );
  const last = led?.entries?.[led.entries.length - 1];
  ok(
    'C5 the last running balance is the closing balance',
    near(n(last?.balance), closing),
    last?.balance,
  );
  ok(
    'C6 every line names the customer by ID',
    (led?.entries ?? []).every((e: any) => e.partyCode === customer.code),
  );

  const stmt = data(
    await req(
      'GET',
      `/customers/${customer.id}/ledger-statement?startDate=${YEAR_START}&endDate=${TODAY}`,
    ),
  ) as any;
  ok(
    'C7 the statement closes where the ledger does',
    near(n(stmt?.closingBalance), closing),
    stmt?.closingBalance,
  );
  ok(
    'C8 the statement leaves out the invoice raised and voided inside the period',
    !(stmt?.lines ?? []).some((l: any) => l.documentId === voided.id),
    stmt?.lines,
  );
  ok(
    'C9 the statement totals',
    near(n(stmt?.totals?.invoiced), 100 * LAKH) &&
      near(n(stmt?.totals?.received), 60 * LAKH),
    stmt?.totals,
  );

  const every = data(
    await req(
      'GET',
      `/ledger?party=customer&startDate=${YEAR_START}&endDate=${TODAY}`,
    ),
  ) as any;
  const book = await gl(['1100', '2400']);
  ok(
    "C10 every customer plus what no customer holds is the book's 1100 + 2400",
    near(n(every?.control?.balance), book) &&
      near(n(every?.control?.linked) + n(every?.control?.unlinked), book),
    { control: every?.control, book },
  );
  const picker = data(
    await req(
      'GET',
      `/ledger/parties?type=customer&startDate=${YEAR_START}&endDate=${TODAY}`,
    ),
  ) as any;
  const mine = (picker?.parties ?? []).find(
    (p: any) => p.partyId === customer.id,
  );
  ok(
    'C11 the picker lists the customer by ID with its closing balance',
    mine?.partyCode === customer.code && near(n(mine?.closing), closing),
    mine,
  );
  ok(
    "C12 invoice search finds them by their customer's ID",
    (
      data(
        await req(
          'GET',
          `/invoices?search=${encodeURIComponent(customer.code)}&limit=50`,
        ),
      ) ?? []
    ).some?.((i: any) => i.id === inv30.id),
  );

  // ═══════════════════════════════════════════════════════════════
  console.log('\n— D. the vendor twin');
  const vendor = data(
    await req('POST', '/vendors', { companyName: `Ledger Vendor ${RUN}` }),
  );
  ok(
    'D1 a new vendor gets the next V-NNNN',
    /^V-\d{4,}$/.test(vendor?.code ?? ''),
    vendor?.code,
  );
  const bill = async (label: string, amount: number) => {
    const res = await req('POST', '/bills', {
      vendorId: vendor.id,
      billNumber: `PL-${RUN}-${label}`,
      billDate: day(-30),
      dueDate: day(0),
      status: 'open',
      lines: [{ description: label, amount: String(amount), taxRate: '0' }],
    });
    ok(
      `bill "${label}" created`,
      res.status < 400 && !!data(res)?.id,
      res.body,
    );
    return data(res);
  };
  const b1 = await bill('A', 30 * LAKH);
  const b2 = await bill('B', 20 * LAKH);
  const accounts = data(await req('GET', '/accounts?limit=500')) as any;
  const list: any[] = Array.isArray(accounts)
    ? accounts
    : (accounts?.accounts ?? []);
  const cash = list.find((a) => a.accountNumber === '1000');
  const fd = new FormData();
  fd.append(
    'proof',
    new Blob([PNG as unknown as BlobPart], { type: 'image/png' }),
    'proof.png',
  );
  const proof = await fetch(`${API}/bill-payments/proofs`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'x-company-id': COMPANY },
    body: fd as any,
  })
    .then((r) => r.json())
    .catch(() => null);
  const paid = await req('POST', '/bills/pay', {
    vendorId: vendor.id,
    paymentDate: TODAY,
    paymentMethod: 'cash',
    bankAccountId: cash?.id,
    reference: `PL-PAY-${RUN}`,
    proofId: (proof?.data ?? proof)?.id,
    applications: [
      { billId: b1.id, amount: (30 * LAKH).toFixed(2) },
      { billId: b2.id, amount: (5 * LAKH).toFixed(2) },
    ],
  });
  ok(
    'D2 one payment of 35 lakh: the first bill in full, 5 on the second',
    paid.status < 400,
    paid.body,
  );
  const vc = await req('POST', '/vendor-credits', {
    vendorId: vendor.id,
    date: TODAY,
    reason: 'party ledger acceptance',
    lines: [
      { description: 'Returned goods', amount: String(2 * LAKH), taxRate: '0' },
    ],
  });
  ok('a vendor credit raised', vc.status < 400, vc.body);

  const vled = data(
    await req(
      'GET',
      `/ledger?party=vendor&partyId=${vendor.id}&startDate=${YEAR_START}&endDate=${TODAY}`,
    ),
  ) as any;
  const vClosing = n(vled?.closingBalances?.[0]?.balance);
  ok(
    "D3 the vendor's ledger is credit-balanced: 50 − 35 − 2 = 13 lakh owed",
    near(vClosing, -13 * LAKH),
    vClosing,
  );
  const vstmt = data(
    await req(
      'GET',
      `/vendors/${vendor.id}/ledger-statement?startDate=${YEAR_START}&endDate=${TODAY}`,
    ),
  ) as any;
  ok(
    'D4 the vendor statement reads it as owed',
    near(n(vstmt?.closingBalance), 13 * LAKH),
    vstmt?.closingBalance,
  );
  const vsum = data(
    await req('GET', `/reports/ap-aging/vendors/${vendor.id}/summary`),
  ) as any;
  ok(
    'D5 and the payables summary agrees',
    near(n(vsum?.netDue), 13 * LAKH),
    vsum?.netDue,
  );
  const everyV = data(
    await req(
      'GET',
      `/ledger?party=vendor&startDate=${YEAR_START}&endDate=${TODAY}`,
    ),
  ) as any;
  const ap = await gl(['2000']);
  ok(
    "D6 every vendor plus what no vendor holds is the book's 2000",
    near(n(everyV?.control?.balance), ap),
    { control: everyV?.control, ap },
  );

  // ═══════════════════════════════════════════════════════════════
  console.log('\n— E. History');
  const hist = data(
    await req(
      'GET',
      `/customers/${customer.id}/history?year=${TODAY.slice(0, 4)}`,
    ),
  ) as any;
  const monthsClose = n(hist?.months?.[hist.months.length - 1]?.balance);
  ok(
    "E1 twelve months that end on the ledger's balance",
    hist?.months?.length === 12 && near(monthsClose, n(hist?.closingBalance)),
    hist?.closingBalance,
  );
  ok(
    "E2 sales less receipts is the year's movement",
    near(
      n(hist?.totals?.sales) - n(hist?.totals?.receipts),
      n(hist?.closingBalance) - n(hist?.openingBalance),
    ),
    hist?.totals,
  );
  ok(
    'E3 the last payment is the 60 lakh receipt',
    near(n(hist?.lastPayment?.amount), 60 * LAKH),
    hist?.lastPayment,
  );
  ok(
    'E4 the last invoice is named',
    !!hist?.lastInvoice?.number,
    hist?.lastInvoice,
  );

  await req('PATCH', `/customers/${customer.id}`, { creditLimit: '7500000' });
  await wait(400);
  await req('PATCH', `/customers/${customer.id}`, {
    creditLimit: '7500000.00',
    phone: '',
  });
  await wait(600);
  const edited = data(
    await req('GET', `/customers/${customer.id}/history`),
  ) as any;
  const limitChanges = (edited?.changes ?? []).filter((c: any) =>
    c.fields?.some((f: any) => f.field === 'creditLimit' && f.from !== null),
  );
  ok(
    'E5 the credit-limit edit is logged once, by name, from 0 to 75 lakh',
    limitChanges.length === 1 &&
      limitChanges[0].user?.name &&
      n(limitChanges[0].fields[0].to) === 7500000,
    edited?.changes,
  );
  ok(
    "E6 the record's creation is the oldest entry",
    edited?.changes?.[edited.changes.length - 1]?.action === 'created',
  );

  const accountView = data(
    await req(
      'GET',
      `/ledger?account=1100&startDate=${YEAR_START}&endDate=${TODAY}`,
    ),
  ) as any;
  ok(
    'E7 the account view answers as it always has',
    accountView?.accountCode === '1100' &&
      Array.isArray(accountView?.entries) &&
      accountView?.party === undefined,
    Object.keys(accountView ?? {}),
  );

  // ═══════════════════════════════════════════════════════════════
  console.log('\n— F. refusals');
  const badParty = await req('GET', '/ledger?party=supplier');
  ok(
    'F1 an unknown party type is 400',
    badParty.status === 400 && codeOf(badParty) === 'INVALID_LEDGER_PARTY',
    badParty.body,
  );
  const badId = await req('GET', '/ledger?party=customer&partyId=nope');
  ok('F2 a malformed party id is 400', badId.status === 400, badId.status);
  const ghost = await req(
    'GET',
    '/ledger?party=customer&partyId=00000000-0000-4000-8000-000000000000',
  );
  ok(
    'F3 an unknown customer is 404',
    ghost.status === 404 && codeOf(ghost) === 'CUSTOMER_NOT_FOUND',
    ghost.body,
  );

  const { rows: riders } = await db.query(
    `SELECT username FROM users
      WHERE role = 'delivery' AND username LIKE 'rpt.rider.%' AND default_company_id = $1
      ORDER BY created_at LIMIT 1`,
    [COMPANY],
  );
  const RIDER_PASSWORD = 'Rider@123';
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
  const riderToken =
    data(
      await req('POST', '/auth/signin', {
        email: riderUsername,
        password: RIDER_PASSWORD,
      }),
    )?.tokens?.accessToken ?? '';
  if (riderToken) {
    for (const [label, path] of [
      [
        "F4 a rider cannot read a customer's ledger",
        `/ledger?party=customer&partyId=${customer.id}`,
      ],
      [
        'F5 a rider cannot read the customer picker',
        '/ledger/parties?type=customer',
      ],
      [
        "F6 a rider cannot read a customer's history",
        `/customers/${customer.id}/history`,
      ],
      [
        'F7 a rider cannot read a statement from the ledger',
        `/customers/${customer.id}/ledger-statement?startDate=${YEAR_START}&endDate=${TODAY}`,
      ],
      ['F8 a rider cannot read the next ID', '/customers/next-code'],
      [
        "F9 a rider cannot read a vendor's history",
        `/vendors/${vendor.id}/history`,
      ],
    ] as const) {
      const r = await req('GET', path, undefined, riderToken);
      ok(label, r.status === 403, r.status);
    }
  } else {
    console.log(
      '  (no rider could sign in on these books — rider checks skipped)',
    );
  }

  await db.end();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) {
    console.log('Failures:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
