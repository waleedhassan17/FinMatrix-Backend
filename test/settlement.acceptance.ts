/**
 * FinMatrix — paying invoices and bills from credit on account, end to end.
 * ==========================================================================
 * POST /payments/settle and POST /bills/settle spend what a customer or vendor
 * already has on account — a customer's advances and credit memos, a vendor's
 * credits — together with new money, in ONE transaction. This drives both on
 * real books and checks the money, the documents and the ledger agree:
 *
 *   A. An overdue invoice paid from an advance + a credit memo + cash, the
 *      cash swept oldest-due-first. The ledger moves exactly as it should, the
 *      trial balance balances, and the summary, the statement and the
 *      customer's balance agree afterwards.
 *   B. Credit only: an advance settles an invoice with no new receipt.
 *   C. Refusals — negative amounts on every route, over-payment by credit +
 *      cash, another customer's credit, an advance applied before it arrived,
 *      an advance held for an open delivery, a non-bank account, a closed
 *      period — and after each, NOTHING moved. A refused cash leg leaves the
 *      credit it came with exactly where it was: that is the atomicity proof.
 *   D. Vendors: a partly used credit + cash settles an overdue bill; credit
 *      only needs no proof; a refused cash leg rolls the credit back.
 *   E. A staff settlement files one approval and moves nothing until the
 *      owner approves it, then settles in full.
 *   F. Riders are refused.
 *
 * Usage: boot the API, then
 *   API_BASE=http://localhost:3000/api/v1 DATABASE_URL=postgres://... \
 *   npx ts-node -r tsconfig-paths/register test/settlement.acceptance.ts
 */
export {};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';
const RUN = Date.now().toString().slice(-8);

const day = (offset: number): string => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Karachi',
  }).format(new Date());
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
    console.log(
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail) : ''}`,
    );
  }
};
const near = (a: number, b: number, tol = 0.005) => Math.abs(a - b) <= tol;
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
      console.log(
        `    (throttled on ${path} — waiting ${Math.round(wait / 1000)}s)`,
      );
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

/** A 1×1 PNG: the smallest thing the proof upload accepts. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  if (!DB) throw new Error('DATABASE_URL is required');
  const db = new Client({ connectionString: DB });
  await db.connect();
  console.log(`\nFinMatrix — settling from credit on account → ${API}\n`);

  const login = await req('POST', '/auth/signin', {
    email: EMAIL,
    password: PASSWORD,
  });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  ok('admin signs in', !!TOKEN && !!COMPANY, login.status);
  if (!TOKEN) throw new Error('cannot sign in');
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  // ── Readers ────────────────────────────────────────────────────
  const gl = async (account: string) => {
    const { rows } = await db.query(
      `SELECT COALESCE(ROUND(SUM(g.debit - g.credit)::numeric, 2), 0) AS v
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id = $1 AND a.account_number = $2`,
      [COMPANY, account],
    );
    return n(rows[0]?.v);
  };
  const count = async (table: string) =>
    n(
      (
        await db.query(
          `SELECT COUNT(*)::int AS c FROM ${table} WHERE company_id = $1`,
          [COMPANY],
        )
      ).rows[0]?.c,
    );
  const invoice = async (id: string) =>
    (
      await db.query(
        `SELECT balance::numeric AS balance, amount_paid::numeric AS paid, status FROM invoices WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const bill = async (id: string) =>
    (
      await db.query(
        `SELECT balance::numeric AS balance, amount_paid::numeric AS paid, status FROM bills WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const memo = async (id: string) =>
    (
      await db.query(
        `SELECT balance::numeric AS balance, status FROM credit_memos WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const vcredit = async (id: string) =>
    (
      await db.query(
        `SELECT balance::numeric AS balance, status FROM vendor_credits WHERE id = $1`,
        [id],
      )
    ).rows[0];
  const unappliedOf = async (paymentId: string) =>
    n(
      (
        await db.query(
          `SELECT p.amount - COALESCE((SELECT SUM(amount_applied) FROM payment_applications WHERE payment_id = p.id), 0) AS u
         FROM payments p WHERE p.id = $1`,
          [paymentId],
        )
      ).rows[0]?.u,
    );
  const trialBalanced = async () =>
    (
      data(
        await req(
          'GET',
          '/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31',
        ),
      ) as any
    )?.isBalanced === true;

  /** Everything a refused settlement must leave alone. */
  const snapshot = async (ids: {
    invoices?: string[];
    bills?: string[];
    memos?: string[];
    vcredits?: string[];
    receipts?: string[];
  }) =>
    JSON.stringify({
      invoices: await Promise.all((ids.invoices ?? []).map(invoice)),
      bills: await Promise.all((ids.bills ?? []).map(bill)),
      memos: await Promise.all((ids.memos ?? []).map(memo)),
      vcredits: await Promise.all((ids.vcredits ?? []).map(vcredit)),
      receipts: await Promise.all((ids.receipts ?? []).map(unappliedOf)),
      payments: await count('payments'),
      billPayments: await count('bill_payments'),
      journals: await count('journal_entries'),
    });

  // ── Masters ────────────────────────────────────────────────────
  const customer = data(
    await req('POST', '/customers', {
      name: `Settle Customer ${RUN}`,
      phone: '0300 7654321',
    }),
  );
  const other = data(
    await req('POST', '/customers', { name: `Settle Other ${RUN}` }),
  );
  const vendor = data(
    await req('POST', '/vendors', { companyName: `Settle Vendor ${RUN}` }),
  );
  const otherVendor = data(
    await req('POST', '/vendors', {
      companyName: `Settle Other Vendor ${RUN}`,
    }),
  );
  ok(
    'masters created',
    !!customer?.id && !!other?.id && !!vendor?.id && !!otherVendor?.id,
  );

  const accounts =
    (data(await req('GET', '/accounts?limit=500')) as any)?.accounts ??
    (data(await req('GET', '/accounts')) as any) ??
    [];
  const list: any[] = Array.isArray(accounts)
    ? accounts
    : (accounts.accounts ?? []);
  const cashAcct = list.find((a) => a.accountNumber === '1000');
  const expenseAcct = list.find((a) => a.type === 'expense');
  ok('cash and an expense account found', !!cashAcct?.id && !!expenseAcct?.id);

  const makeInvoice = async (
    customerId: string,
    label: string,
    invoiceDate: string,
    dueDate: string,
    price: number,
  ) => {
    const r = await req('POST', '/invoices', {
      customerId,
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
    ok(`invoice "${label}"`, r.status < 400 && !!data(r)?.id, r.body);
    return data(r);
  };
  const advance = async (
    customerId: string,
    amount: number,
    paymentDate = TODAY,
  ) => {
    const r = await req('POST', '/payments', {
      customerId,
      paymentDate,
      paymentMethod: 'cash',
      amount: amount.toFixed(2),
      holdAsAdvance: true,
    });
    ok(`advance of ${amount} held`, r.status < 400 && !!data(r)?.id, r.body);
    return data(r);
  };
  const creditMemo = async (customerId: string, amount: number) => {
    const r = await req('POST', '/credit-memos', {
      customerId,
      date: TODAY,
      reason: 'settlement acceptance',
      lines: [
        {
          description: 'Credit',
          quantity: '1',
          unitPrice: String(amount),
          taxRate: '0',
        },
      ],
    });
    ok(`credit memo of ${amount}`, r.status < 400 && !!data(r)?.id, r.body);
    return data(r);
  };

  // ═══════════════════════════════════════════════════════════════
  // A. An overdue invoice from an advance + a credit memo + cash
  // ═══════════════════════════════════════════════════════════════
  console.log(
    '\n— A. an overdue invoice paid from an advance, a credit memo and cash',
  );
  const overdue = await makeInvoice(
    customer.id,
    'Overdue',
    day(-75),
    day(-45),
    1000,
  );
  const current = await makeInvoice(
    customer.id,
    'Current',
    day(-5),
    day(25),
    600,
  );
  const adv = await advance(customer.id, 300);
  const cm = await creditMemo(customer.id, 200);

  const before = {
    ar: await gl('1100'),
    adv: await gl('2400'),
    cash: await gl('1000'),
    receipts: await count('payments'),
  };
  const settleA = await req('POST', '/payments/settle', {
    customerId: customer.id,
    paymentDate: TODAY,
    credits: [
      { kind: 'advance', id: adv.id, invoiceId: overdue.id, amount: '300' },
      { kind: 'credit_memo', id: cm.id, invoiceId: overdue.id, amount: '200' },
    ],
    // No applications: the receipt sweeps oldest-due-first over what credit left.
    cash: { amount: '500', paymentMethod: 'cash' },
  });
  const sA = data(settleA) as any;
  ok(
    'A1 the settlement answers 200 with a receipt and both credits',
    settleA.status === 200 && !!sA?.payment?.id && sA?.credits?.length === 2,
    settleA.body,
  );
  ok(
    'A2 500 from credit, 500 in cash',
    near(n(sA?.creditTotal), 500) && near(n(sA?.cashTotal), 500),
    sA,
  );
  const ovA = await invoice(overdue.id);
  ok(
    'A3 the overdue invoice is paid in full',
    near(n(ovA.balance), 0) && ovA.status === 'paid',
    ovA,
  );
  const curA = await invoice(current.id);
  ok(
    'A4 the cash went oldest-due-first: the current invoice is untouched',
    near(n(curA.balance), 600),
    curA,
  );
  ok(
    'A5 the advance is spent and the credit memo closed',
    near(await unappliedOf(adv.id), 0) &&
      (await memo(cm.id)).status === 'closed',
    { memo: await memo(cm.id) },
  );
  ok(
    'A6 the receipt holds nothing back (nothing left to hold)',
    near(n(sA?.payment?.unapplied), 0),
    sA?.payment,
  );
  const after = {
    ar: await gl('1100'),
    adv: await gl('2400'),
    cash: await gl('1000'),
    receipts: await count('payments'),
  };
  ok(
    'A7 the ledger: A/R −800 (advance 300 + cash 500; the memo credited A/R when it was raised), advances +300 (debited), cash +500',
    near(after.ar - before.ar, -800) &&
      near(after.adv - before.adv, 300) &&
      near(after.cash - before.cash, 500),
    { before, after },
  );
  ok('A8 exactly one new receipt', after.receipts - before.receipts === 1, {
    before: before.receipts,
    after: after.receipts,
  });
  ok('A9 the trial balance balances', await trialBalanced());
  const summaryA = data(
    await req('GET', `/reports/ar-aging/customers/${customer.id}/summary`),
  ) as any;
  const stmtA = data(
    await req(
      'GET',
      `/customers/${customer.id}/statement?startDate=${day(-90)}&endDate=${TODAY}`,
    ),
  ) as any;
  const custA = data(await req('GET', `/customers/${customer.id}`)) as any;
  const custBalance = n(custA?.customer?.balance ?? custA?.balance);
  ok(
    'A10 summary, statement and customer balance all say 600',
    near(n(summaryA?.netDue), 600) &&
      near(n(stmtA?.closingBalance), 600) &&
      near(custBalance, 600),
    {
      netDue: summaryA?.netDue,
      statement: stmtA?.closingBalance,
      balance: custBalance,
    },
  );

  // ═══════════════════════════════════════════════════════════════
  // B. Credit only
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— B. an advance alone settles part of an invoice');
  const adv2 = await advance(customer.id, 250);
  const receiptsB = await count('payments');
  const settleB = await req('POST', '/payments/settle', {
    customerId: customer.id,
    paymentDate: TODAY,
    credits: [
      { kind: 'advance', id: adv2.id, invoiceId: current.id, amount: '250' },
    ],
  });
  const sB = data(settleB) as any;
  ok(
    'B1 settled with no new receipt',
    settleB.status === 200 &&
      sB?.payment === null &&
      near(n(sB?.creditTotal), 250),
    settleB.body,
  );
  const curB = await invoice(current.id);
  ok(
    'B2 the invoice is part-paid: 350 left',
    near(n(curB.balance), 350) && curB.status === 'partial',
    curB,
  );
  ok('B3 no receipt was created', (await count('payments')) === receiptsB);

  // ═══════════════════════════════════════════════════════════════
  // C. Refusals — and nothing moves
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— C. refusals, each leaving everything where it was');
  const cm2 = await creditMemo(customer.id, 100);
  const adv3 = await advance(customer.id, 40);
  const otherInvoice = await makeInvoice(
    other.id,
    'Other customer',
    day(-3),
    day(27),
    90,
  );
  const otherMemo = await creditMemo(other.id, 30);
  const ids = {
    invoices: [current.id, otherInvoice.id],
    memos: [cm2.id, otherMemo.id],
    receipts: [adv3.id],
  };

  const refusals: Array<
    [string, () => Promise<{ status: number; body: any }>, string]
  > = [
    [
      'C1 a negative credit',
      () =>
        req('POST', '/payments/settle', {
          customerId: customer.id,
          paymentDate: TODAY,
          credits: [
            {
              kind: 'credit_memo',
              id: cm2.id,
              invoiceId: current.id,
              amount: '-50',
            },
          ],
        }),
      'VALIDATION_FAILED',
    ],
    [
      'C2 credit + cash paying more than the invoice owes (credit leg rolled back)',
      () =>
        req('POST', '/payments/settle', {
          customerId: customer.id,
          paymentDate: TODAY,
          credits: [
            {
              kind: 'credit_memo',
              id: cm2.id,
              invoiceId: current.id,
              amount: '100',
            },
          ],
          cash: {
            amount: '300',
            paymentMethod: 'cash',
            applications: [{ invoiceId: current.id, amount: '300' }],
          },
        }),
      'PAYMENT_EXCEEDS_BALANCE',
    ],
    [
      "C3 another customer's credit memo",
      () =>
        req('POST', '/payments/settle', {
          customerId: customer.id,
          paymentDate: TODAY,
          credits: [
            {
              kind: 'credit_memo',
              id: otherMemo.id,
              invoiceId: current.id,
              amount: '30',
            },
          ],
        }),
      'CUSTOMER_MISMATCH',
    ],
    [
      "C4 this customer's credit on another customer's invoice",
      () =>
        req('POST', '/payments/settle', {
          customerId: customer.id,
          paymentDate: TODAY,
          credits: [
            {
              kind: 'credit_memo',
              id: cm2.id,
              invoiceId: otherInvoice.id,
              amount: '50',
            },
          ],
        }),
      'INVOICE_CUSTOMER_MISMATCH',
    ],
    [
      'C5 an advance applied before the money arrived',
      () =>
        req('POST', '/payments/settle', {
          customerId: customer.id,
          paymentDate: day(-1),
          credits: [
            {
              kind: 'advance',
              id: adv3.id,
              invoiceId: current.id,
              amount: '40',
            },
          ],
        }),
      'APPLIED_BEFORE_RECEIPT',
    ],
    [
      'C6 cash into an expense account (credit leg rolled back)',
      () =>
        req('POST', '/payments/settle', {
          customerId: customer.id,
          paymentDate: TODAY,
          credits: [
            {
              kind: 'credit_memo',
              id: cm2.id,
              invoiceId: current.id,
              amount: '100',
            },
          ],
          cash: {
            amount: '50',
            paymentMethod: 'bank_transfer',
            bankAccountId: expenseAcct.id,
          },
        }),
      'INVALID_PAYMENT_ACCOUNT',
    ],
    [
      'C7 a receipt with a negative application',
      () =>
        req('POST', '/payments', {
          customerId: customer.id,
          paymentDate: TODAY,
          paymentMethod: 'cash',
          amount: '100',
          applications: [{ invoiceId: current.id, amount: '-100' }],
        }),
      'VALIDATION_FAILED',
    ],
    [
      'C8 a credit memo applied as a negative amount',
      () =>
        req('POST', `/credit-memos/${cm2.id}/apply`, {
          invoiceId: current.id,
          amount: '-50',
        }),
      'VALIDATION_FAILED',
    ],
    [
      'C9 an advance applied as a negative amount',
      () =>
        req('POST', `/payments/${adv3.id}/apply`, {
          applications: [{ invoiceId: current.id, amount: '-10' }],
        }),
      'VALIDATION_FAILED',
    ],
    [
      'C10 nothing to settle',
      () =>
        req('POST', '/payments/settle', {
          customerId: customer.id,
          paymentDate: TODAY,
        }),
      'NOTHING_TO_SETTLE',
    ],
  ];
  for (const [label, run, code] of refusals) {
    const snap = await snapshot(ids);
    const r = await run();
    const same = (await snapshot(ids)) === snap;
    ok(
      `${label} → ${code}, nothing moved`,
      r.status >= 400 && r.status < 500 && codeOf(r) === code && same,
      {
        status: r.status,
        code: codeOf(r),
        same,
        body: r.status >= 500 ? r.body : undefined,
      },
    );
  }

  // An advance held for a delivery still on its way belongs to that delivery.
  const { rows: stock } = await db.query(
    `SELECT id, name FROM inventory_items WHERE company_id = $1 AND is_active AND quantity_on_hand > 5
      ORDER BY name LIMIT 1`,
    [COMPANY],
  );
  if (stock[0]) {
    const delivery = data(
      await req('POST', '/deliveries', {
        customerId: customer.id,
        customerName: customer.name,
        items: [
          {
            itemId: stock[0].id,
            itemName: stock[0].name,
            orderedQty: 1,
            unitPrice: 100,
          },
        ],
        advanceAmount: '100',
      }),
    ) as any;
    const reserved = delivery?.advancePaymentId;
    if (reserved) {
      const snap = await snapshot({ ...ids, receipts: [reserved] });
      const r = await req('POST', '/payments/settle', {
        customerId: customer.id,
        paymentDate: TODAY,
        credits: [
          {
            kind: 'advance',
            id: reserved,
            invoiceId: current.id,
            amount: '100',
          },
        ],
      });
      ok(
        'C11 an advance held for an open delivery → ADVANCE_RESERVED, nothing moved',
        codeOf(r) === 'ADVANCE_RESERVED' &&
          (await snapshot({ ...ids, receipts: [reserved] })) === snap,
        { status: r.status, code: codeOf(r) },
      );
    } else {
      ok('C11 a delivery with an advance could be created', false, delivery);
    }
  }

  // A closed period: the credit memo leg posts nothing, the receipt is refused
  // — and the memo must not stay applied behind it.
  const lock = await req('POST', `/companies/${COMPANY}/period-close`, {
    lockDate: day(-1),
  });
  if (lock.status < 400) {
    const snap = await snapshot(ids);
    const r = await req('POST', '/payments/settle', {
      customerId: customer.id,
      paymentDate: day(-1),
      credits: [
        {
          kind: 'credit_memo',
          id: cm2.id,
          invoiceId: current.id,
          amount: '100',
        },
      ],
      cash: { amount: '50', paymentMethod: 'cash' },
    });
    ok(
      'C12 a settlement dated in a closed period → PERIOD_LOCKED, the memo not left applied',
      codeOf(r) === 'PERIOD_LOCKED' && (await snapshot(ids)) === snap,
      { status: r.status, code: codeOf(r) },
    );
  } else {
    ok('C12 the period could be closed for the test', false, lock.body);
  }
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  // ═══════════════════════════════════════════════════════════════
  // D. Vendors
  // ═══════════════════════════════════════════════════════════════
  console.log(
    '\n— D. an overdue bill from a partly used vendor credit and cash',
  );
  const makeBill = async (
    vendorId: string,
    label: string,
    billDate: string,
    dueDate: string,
    amount: number,
  ) => {
    const r = await req('POST', '/bills', {
      vendorId,
      billNumber: `SET-${RUN}-${label}`,
      billDate,
      dueDate,
      status: 'open',
      lines: [{ description: label, amount: String(amount), taxRate: '0' }],
    });
    ok(`bill "${label}"`, r.status < 400 && !!data(r)?.id, r.body);
    return data(r);
  };
  const vendorCredit = async (vendorId: string, amount: number) => {
    const r = await req('POST', '/vendor-credits', {
      vendorId,
      date: TODAY,
      reason: 'settlement acceptance',
      lines: [
        { description: 'Returned goods', amount: String(amount), taxRate: '0' },
      ],
    });
    ok(`vendor credit of ${amount}`, r.status < 400 && !!data(r)?.id, r.body);
    return data(r);
  };
  const uploadProof = async () => {
    const fd = new FormData();
    fd.append(
      'proof',
      new Blob([PNG as unknown as BlobPart], { type: 'image/png' }),
      'proof.png',
    );
    const r = await fetch(`${API}/bill-payments/proofs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'x-company-id': COMPANY },
      body: fd as any,
    });
    const body: any = await r.json().catch(() => null);
    return (body?.data ?? body)?.id as string;
  };

  const lateBill = await makeBill(vendor.id, 'LATE', day(-40), day(-35), 700);
  const dueBill = await makeBill(vendor.id, 'DUE', day(-2), day(28), 300);
  const vc1 = await vendorCredit(vendor.id, 200);
  const partUse = await req('POST', `/vendor-credits/${vc1.id}/apply`, {
    billId: dueBill.id,
    amount: '50',
  });
  ok(
    'a vendor credit partly used (status applied, 150 left)',
    partUse.status < 400 &&
      (await vcredit(vc1.id)).status === 'applied' &&
      near(n((await vcredit(vc1.id)).balance), 150),
    partUse.body,
  );

  const negVc = await req('POST', `/vendor-credits/${vc1.id}/apply`, {
    billId: dueBill.id,
    amount: '-25',
  });
  ok(
    'D0 a vendor credit applied as a negative amount → VALIDATION_FAILED, nothing moved',
    codeOf(negVc) === 'VALIDATION_FAILED' &&
      near(n((await vcredit(vc1.id)).balance), 150) &&
      near(n((await bill(dueBill.id)).balance), 250),
    { code: codeOf(negVc) },
  );

  const proof1 = await uploadProof();
  ok('a payment proof uploaded', !!proof1);
  const apBefore = await gl('2000');
  const cashBefore = await gl('1000');
  const settleD = await req('POST', '/bills/settle', {
    vendorId: vendor.id,
    paymentDate: TODAY,
    credits: [{ vendorCreditId: vc1.id, billId: lateBill.id, amount: '150' }],
    cash: {
      paymentMethod: 'cash',
      bankAccountId: cashAcct.id,
      proofId: proof1,
      applications: [{ billId: lateBill.id, amount: '550' }],
    },
  });
  const sD = data(settleD) as any;
  ok(
    'D1 settled: 150 from credit, 550 in cash',
    settleD.status === 200 &&
      near(n(sD?.creditTotal), 150) &&
      near(n(sD?.cashTotal), 550) &&
      !!sD?.payment?.id,
    settleD.body,
  );
  const lateD = await bill(lateBill.id);
  ok(
    'D2 the overdue bill is paid',
    near(n(lateD.balance), 0) && lateD.status === 'paid',
    lateD,
  );
  ok(
    'D3 the partly used credit is now closed',
    (await vcredit(vc1.id)).status === 'closed' &&
      near(n((await vcredit(vc1.id)).balance), 0),
  );
  ok(
    'D4 the ledger: A/P debited 550, cash credited 550 (the credit posted when it was raised)',
    near((await gl('2000')) - apBefore, 550) &&
      near((await gl('1000')) - cashBefore, -550),
    {
      ap: (await gl('2000')) - apBefore,
      cash: (await gl('1000')) - cashBefore,
    },
  );

  console.log('\n— D. credit alone, and a refused cash leg');
  const vc2 = await vendorCredit(vendor.id, 100);
  const bpBefore = await count('bill_payments');
  const jeBefore = await count('journal_entries');
  const creditOnly = await req('POST', '/bills/settle', {
    vendorId: vendor.id,
    paymentDate: TODAY,
    credits: [{ vendorCreditId: vc2.id, billId: dueBill.id, amount: '100' }],
  });
  ok(
    'D5 credit only: no proof, no payment, no journal entry',
    creditOnly.status === 200 &&
      data(creditOnly)?.payment === null &&
      (await count('bill_payments')) === bpBefore &&
      (await count('journal_entries')) === jeBefore,
    creditOnly.body,
  );
  ok(
    'D6 the bill is down to 150',
    near(n((await bill(dueBill.id)).balance), 150),
  );

  const vc3 = await vendorCredit(vendor.id, 80);
  const vendorRefusals: Array<
    [string, () => Promise<{ status: number; body: any }>, string]
  > = [
    [
      'D7 a used proof: the credit leg rolls back',
      () =>
        req('POST', '/bills/settle', {
          vendorId: vendor.id,
          paymentDate: TODAY,
          credits: [
            { vendorCreditId: vc3.id, billId: dueBill.id, amount: '80' },
          ],
          cash: {
            paymentMethod: 'cash',
            bankAccountId: cashAcct.id,
            proofId: proof1,
            applications: [{ billId: dueBill.id, amount: '70' }],
          },
        }),
      'PAYMENT_PROOF_ALREADY_USED',
    ],
    [
      'D8 credit + cash paying more than the bill owes',
      async () =>
        req('POST', '/bills/settle', {
          vendorId: vendor.id,
          paymentDate: TODAY,
          credits: [
            { vendorCreditId: vc3.id, billId: dueBill.id, amount: '80' },
          ],
          cash: {
            paymentMethod: 'cash',
            bankAccountId: cashAcct.id,
            proofId: await uploadProof(),
            applications: [{ billId: dueBill.id, amount: '100' }],
          },
        }),
      'PAYMENT_EXCEEDS_BALANCE',
    ],
    [
      'D9 a bill payment from an expense account',
      async () =>
        req('POST', '/bills/pay', {
          vendorId: vendor.id,
          paymentDate: TODAY,
          paymentMethod: 'bank_transfer',
          bankAccountId: expenseAcct.id,
          proofId: await uploadProof(),
          applications: [{ billId: dueBill.id, amount: '10' }],
        }),
      'INVALID_PAYMENT_ACCOUNT',
    ],
    [
      "D10 another vendor's credit",
      async () => {
        const foreign = await vendorCredit(otherVendor.id, 20);
        return req('POST', '/bills/settle', {
          vendorId: vendor.id,
          paymentDate: TODAY,
          credits: [
            { vendorCreditId: foreign.id, billId: dueBill.id, amount: '20' },
          ],
        });
      },
      'VENDOR_MISMATCH',
    ],
    [
      'D11 nothing to settle',
      () =>
        req('POST', '/bills/settle', {
          vendorId: vendor.id,
          paymentDate: TODAY,
        }),
      'NOTHING_TO_SETTLE',
    ],
  ];
  // A vendor refusal must leave the bill, the credit and the payment count as
  // they were (proof uploads and another vendor's new credit are not this
  // vendor's books moving).
  const vendorSnap = async () =>
    JSON.stringify({
      bill: await bill(dueBill.id),
      credit: await vcredit(vc3.id),
      billPayments: await count('bill_payments'),
    });
  for (const [label, run, code] of vendorRefusals) {
    const snap = await vendorSnap();
    const r = await run();
    const same = (await vendorSnap()) === snap;
    ok(
      `${label} → ${code}, nothing moved`,
      r.status >= 400 && r.status < 500 && codeOf(r) === code && same,
      { status: r.status, code: codeOf(r), same },
    );
  }

  const payables = data(
    await req('GET', `/reports/ap-aging/vendors/${vendor.id}/summary`),
  ) as any;
  const vstmt = data(
    await req(
      'GET',
      `/vendors/${vendor.id}/statement?startDate=${day(-90)}&endDate=${TODAY}`,
    ),
  ) as any;
  const vendorRow = data(await req('GET', `/vendors/${vendor.id}`)) as any;
  ok(
    'D12 payables summary, statement and vendor balance agree (150 owed, 80 credit → 70)',
    near(n(payables?.netDue), 70) &&
      near(n(vstmt?.closingBalance), 70) &&
      near(n(vendorRow?.balance), 70),
    {
      netDue: payables?.netDue,
      statement: vstmt?.closingBalance,
      balance: vendorRow?.balance,
    },
  );
  ok('D13 the trial balance balances', await trialBalanced());

  // ═══════════════════════════════════════════════════════════════
  // E. Staff ask, the owner approves
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— E. a staff settlement waits for the owner');
  const staffUser = `settle.staff.${RUN}`;
  const staff = await req('POST', '/settings/users', {
    name: 'Settle Staff',
    username: staffUser,
    password: 'Test1234!',
    role: 'staff',
  });
  if (staff.status === 201 || staff.status === 200) {
    const staffLogin = await req('POST', '/auth/signin', {
      email: staffUser,
      password: 'Test1234!',
    });
    const ST = data(staffLogin)?.tokens?.accessToken;
    const snap = await snapshot({ invoices: [current.id], memos: [cm2.id] });
    const asked = await req(
      'POST',
      '/payments/settle',
      {
        customerId: customer.id,
        paymentDate: TODAY,
        credits: [
          {
            kind: 'credit_memo',
            id: cm2.id,
            invoiceId: current.id,
            amount: '100',
          },
        ],
        cash: {
          amount: '50',
          paymentMethod: 'cash',
          applications: [{ invoiceId: current.id, amount: '50' }],
        },
      },
      ST,
    );
    const pending = data(asked) as any;
    ok(
      'E1 staff settlement is filed for the owner',
      pending?.pending === true && !!pending?.requestId,
      asked.body,
    );
    ok(
      'E2 nothing moved yet',
      (await snapshot({ invoices: [current.id], memos: [cm2.id] })) === snap,
    );
    const decided = await req(
      'POST',
      `/approvals/${pending?.requestId}/decide`,
      { decision: 'approve' },
    );
    ok(
      'E3 the owner approves it',
      decided.status === 200 && data(decided)?.status === 'approved',
      decided.body,
    );
    const curE = await invoice(current.id);
    ok(
      'E4 the approval settled it whole: memo 100 + cash 50 → 200 left',
      near(n(curE.balance), 200) && (await memo(cm2.id)).status === 'closed',
      curE,
    );

    const vAsked = await req(
      'POST',
      '/bills/settle',
      {
        vendorId: vendor.id,
        paymentDate: TODAY,
        credits: [{ vendorCreditId: vc3.id, billId: dueBill.id, amount: '80' }],
      },
      ST,
    );
    const vPending = data(vAsked) as any;
    ok(
      'E5 a staff vendor settlement is filed, and nothing moved',
      vPending?.pending === true &&
        near(n((await vcredit(vc3.id)).balance), 80),
      vAsked.body,
    );
    const vDecided = await req(
      'POST',
      `/approvals/${vPending?.requestId}/decide`,
      { decision: 'approve' },
    );
    ok(
      'E6 approved, the credit is spent',
      vDecided.status === 200 &&
        (await vcredit(vc3.id)).status === 'closed' &&
        near(n((await bill(dueBill.id)).balance), 70),
      vDecided.body,
    );
    // Give the seat back: a company has one, and a rerun on the same books
    // would otherwise find it taken and skip this section.
    await req('PATCH', `/settings/users/${data(staff)?.id}/deactivate`);
  } else {
    console.log(`    (no staff seat free — skipped E: ${codeOf(staff)})`);
  }

  // ═══════════════════════════════════════════════════════════════
  // F. Riders
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— F. riders');
  const { rows: riders } = await db.query(
    `SELECT username FROM users WHERE role = 'delivery' AND username LIKE 'rpt.rider.%' AND default_company_id = $1
      ORDER BY created_at LIMIT 1`,
    [COMPANY],
  );
  let riderUsername: string = riders[0]?.username ?? '';
  if (!riderUsername) {
    riderUsername = `rpt.rider.${RUN}`;
    await req('POST', '/delivery-personnel', {
      username: riderUsername,
      password: 'Rider@123',
      name: `Rider ${RUN}`,
      email: `rider_${RUN}@qa.local`,
    });
  }
  const riderToken =
    data(
      await req('POST', '/auth/signin', {
        email: riderUsername,
        password: 'Rider@123',
      }),
    )?.tokens?.accessToken ?? '';
  const riderA = await req(
    'POST',
    '/payments/settle',
    {
      customerId: customer.id,
      paymentDate: TODAY,
      cash: { amount: '1', paymentMethod: 'cash' },
    },
    riderToken,
  );
  const riderB = await req(
    'POST',
    '/bills/settle',
    { vendorId: vendor.id, paymentDate: TODAY, credits: [] },
    riderToken,
  );
  ok(
    'F1 a rider can settle neither side (403)',
    riderA.status === 403 && riderB.status === 403,
    [riderA.status, riderB.status],
  );

  ok('Z the trial balance still balances at the end', await trialBalanced());
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
