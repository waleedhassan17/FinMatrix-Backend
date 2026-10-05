/**
 * FinMatrix — bank accounts are usable everywhere money moves.
 * ===========================================================================
 *
 *   A. Bank accounts made in the chart (MCB with an opening balance, Allied
 *      without) are assets of kind Bank and are offered wherever money moves.
 *   B. A bill paid from MCB credits MCB; a receipt deposited to Allied debits
 *      Allied; a receipt left on Automatic still lands in Cash.
 *   C. A bank account saved by mistake as an expense ("Meezan Bank", Other
 *      Expense, 5xxx) is refused as a payment account, and — because nothing
 *      refers to it yet — can be made a bank account with a bank's number.
 *      Once it has a posting its type and number are fixed again; a system
 *      account's type, kind and number are fixed from the start; a taken
 *      number is refused by name.
 *   D. A tax payment from MCB credits MCB and remembers it, so deleting it
 *      puts the money back in MCB; with no account it is Cash, as before; an
 *      expense is refused before anything is written.
 *   E. Payroll processed from Allied pays net from Allied; an inactive bank is
 *      refused and the run stays a draft.
 *   F. A credit memo refunded from MCB credits MCB and says so; a staff
 *      refund request names its account and pays from it when approved; a
 *      reversal that refunds its remainder uses the account it was given.
 *   G. Reports: the reconciliation for MCB lists those movements, the cash
 *      flow ends on every cash and bank account together, and the trial
 *      balance balances.
 *
 * Each run makes its own accounts, parties and documents, so it holds on books
 * that already contain data.
 *
 * Usage: boot the API, then
 *   API_BASE=http://localhost:3000/api/v1 \
 *   DATABASE_URL=postgres://... \
 *   npx ts-node -r tsconfig-paths/register test/bank-accounts.acceptance.ts
 */
export {};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';
const RUN = Date.now().toString().slice(-8);

/** Today in the business zone. */
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
}).format(new Date());

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
const messageOf = (r: { body: any }): string =>
  String(r.body?.error?.message ?? r.body?.message ?? '');

async function main() {
  if (!DB) throw new Error('DATABASE_URL is required');
  const db = new Client({ connectionString: DB });
  await db.connect();

  /** An account's balance as the books hold it. */
  const balance = async (accountId: string) => {
    const { rows } = await db.query(
      `SELECT balance FROM accounts WHERE id = $1`,
      [accountId],
    );
    return n(rows[0]?.balance);
  };
  /** Debit − credit a source document posted to one account. */
  const posted = async (accountId: string, sourceId: string) => {
    const { rows } = await db.query(
      `SELECT COALESCE(SUM(debit - credit), 0) AS v
         FROM general_ledger WHERE company_id = $1 AND account_id = $2 AND source_id = $3`,
      [COMPANY, accountId, sourceId],
    );
    return n(rows[0]?.v);
  };
  /** A number in [min, max] no account of this company has yet. */
  const freeNumber = async (min: number, max: number) => {
    const { rows } = await db.query(
      `SELECT account_number FROM accounts WHERE company_id = $1`,
      [COMPANY],
    );
    const used = new Set(rows.map((r: any) => r.account_number));
    for (let v = min + 7; v <= max; v += 1) {
      if (!used.has(String(v))) return String(v);
    }
    throw new Error(`no free account number in ${min}–${max}`);
  };
  const uploadProof = async () => {
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
    return (proof?.data ?? proof)?.id as string;
  };

  console.log(`\nFinMatrix — bank accounts everywhere money moves → ${API}\n`);
  const login = await req('POST', '/auth/signin', {
    email: EMAIL,
    password: PASSWORD,
  });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  ok('admin signs in', !!TOKEN && !!COMPANY, login.status);
  if (!TOKEN) throw new Error('cannot sign in');
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  const chart = (data(await req('GET', '/accounts')) as any)?.accounts ?? [];
  const cash = chart.find((a: any) => a.accountNumber === '1000');
  const checking = chart.find((a: any) => a.accountNumber === '1010');
  ok('the chart has Cash and Business Checking', !!cash && !!checking);

  // ═══════════════════════════════════════════════════════════════
  console.log('— A. bank accounts made in the chart');
  const mcbRes = await req('POST', '/accounts', {
    accountNumber: await freeNumber(1010, 1099),
    name: `MCB Current ${RUN}`,
    type: 'asset',
    subType: 'Bank',
    openingBalance: '500000',
  });
  const mcb = data(mcbRes);
  ok(
    'A1 MCB is created as an asset of kind Bank, holding its opening 500,000',
    mcbRes.status < 400 &&
      mcb?.type === 'asset' &&
      mcb?.subType === 'Bank' &&
      near(await balance(mcb.id), 500000),
    mcbRes.body,
  );
  const alliedRes = await req('POST', '/accounts', {
    accountNumber: await freeNumber(1010, 1099),
    name: `Allied Bank ${RUN}`,
    type: 'asset',
    subType: 'Bank',
  });
  const allied = data(alliedRes);
  ok(
    'A2 Allied Bank is created with nothing in it',
    alliedRes.status < 400 && !!allied?.id,
    alliedRes.body,
  );
  const offered = (
    (data(await req('GET', '/accounts?type=asset&isActive=true')) as any)
      ?.accounts ?? []
  )
    .filter((a: any) => ['Cash', 'Bank'].includes(a.subType))
    .map((a: any) => a.id);
  ok(
    'A3 both are among the cash and bank accounts every payment picker offers',
    offered.includes(mcb.id) &&
      offered.includes(allied.id) &&
      offered.includes(cash.id),
  );

  // ═══════════════════════════════════════════════════════════════
  console.log('\n— B. paying and receiving through them');
  const vendor = data(
    await req('POST', '/vendors', { companyName: `Bank Vendor ${RUN}` }),
  );
  const bill = async (label: string, amount: number) => {
    const res = await req('POST', '/bills', {
      vendorId: vendor.id,
      billNumber: `BA-${RUN}-${label}`,
      billDate: TODAY,
      dueDate: TODAY,
      status: 'open',
      lines: [{ description: label, amount: String(amount), taxRate: '0' }],
    });
    return data(res);
  };
  const pay = async (billId: string, amount: number, bankAccountId: string) =>
    req('POST', '/bills/pay', {
      vendorId: vendor.id,
      paymentDate: TODAY,
      paymentMethod: 'bank_transfer',
      bankAccountId,
      reference: `BA-PAY-${RUN}`,
      proofId: await uploadProof(),
      applications: [{ billId, amount: amount.toFixed(2) }],
    });

  const b1 = await bill('MCB', 100000);
  const mcbBefore = await balance(mcb.id);
  const paidMcb = await pay(b1.id, 100000, mcb.id);
  ok(
    'B1 a bill paid from MCB takes 100,000 out of MCB',
    paidMcb.status < 400 && near(await balance(mcb.id), mcbBefore - 100000),
    paidMcb.body,
  );
  const { rows: bp } = await db.query(
    `SELECT bank_account_id FROM bill_payments WHERE company_id = $1 AND reference = $2`,
    [COMPANY, `BA-PAY-${RUN}`],
  );
  ok(
    'B2 the bill payment records MCB as the account it was paid from',
    bp[0]?.bank_account_id === mcb.id,
    bp,
  );

  const customer = data(
    await req('POST', '/customers', {
      name: `Bank Customer ${RUN}`,
      creditLimit: '0',
    }),
  );
  const invoice = data(
    await req('POST', '/invoices', {
      customerId: customer.id,
      invoiceDate: TODAY,
      dueDate: TODAY,
      status: 'sent',
      lines: [
        {
          description: 'Service',
          quantity: '1',
          unitPrice: '80000',
          taxRate: '0',
          lineKind: 'service',
        },
      ],
    }),
  );
  const alliedBefore = await balance(allied.id);
  const received = await req('POST', '/payments', {
    customerId: customer.id,
    paymentDate: TODAY,
    paymentMethod: 'bank_transfer',
    amount: '80000.00',
    bankAccountId: allied.id,
    applications: [{ invoiceId: invoice.id, amount: '80000.00' }],
  });
  ok(
    'B3 a receipt deposited to Allied puts 80,000 in Allied',
    received.status < 400 &&
      data(received)?.bankAccountId === allied.id &&
      near(await balance(allied.id), alliedBefore + 80000),
    received.body,
  );
  const cashBefore = await balance(cash.id);
  const automatic = await req('POST', '/payments', {
    customerId: customer.id,
    paymentDate: TODAY,
    paymentMethod: 'cash',
    amount: '1500.00',
    holdAsAdvance: true,
  });
  ok(
    'B4 a cash receipt left on Automatic still lands in 1000 Cash',
    automatic.status < 400 &&
      data(automatic)?.bankAccountId === cash.id &&
      near(await balance(cash.id), cashBefore + 1500),
    automatic.body,
  );

  // ═══════════════════════════════════════════════════════════════
  console.log('\n— C. a bank account saved by mistake as an expense');
  const meezanRes = await req('POST', '/accounts', {
    accountNumber: await freeNumber(5000, 5399),
    name: `MEEZAN BANK ${RUN}`,
    type: 'expense',
    subType: 'Other Expense',
  });
  const meezan = data(meezanRes);
  ok(
    'C1 "Meezan Bank" saved as an Other Expense',
    meezanRes.status < 400 && meezan?.type === 'expense',
    meezanRes.body,
  );
  const fresh = data(await req('GET', `/accounts/${meezan.id}`)) as any;
  ok(
    'C2 nothing refers to it yet, so its type and number may change',
    fresh?.structure?.editable === true &&
      fresh?.structure?.reason === null &&
      n(fresh?.usage?.postings) === 0,
    fresh?.structure,
  );
  const b2 = await bill('Meezan', 25000);
  const refused = await pay(b2.id, 25000, meezan.id);
  ok(
    'C3 paying from it is refused: it is not a cash or bank account',
    refused.status === 400 && codeOf(refused) === 'INVALID_PAYMENT_ACCOUNT',
    refused.body,
  );
  const bankNumber = await freeNumber(1010, 1099);
  const converted = await req('PATCH', `/accounts/${meezan.id}`, {
    type: 'asset',
    subType: 'Bank',
    accountNumber: bankNumber,
  });
  ok(
    'C4 it becomes an asset of kind Bank with a bank number',
    converted.status === 200 &&
      data(converted)?.type === 'asset' &&
      data(converted)?.subType === 'Bank' &&
      data(converted)?.accountNumber === bankNumber,
    converted.body,
  );
  const paidMeezan = await pay(b2.id, 25000, meezan.id);
  ok(
    'C5 now a bill can be paid from it, and the ledger credits it',
    paidMeezan.status < 400 && near(await balance(meezan.id), -25000),
    paidMeezan.body,
  );
  const used = data(await req('GET', `/accounts/${meezan.id}`)) as any;
  ok(
    'C6 with a posting on it, its type and number are fixed again — and it says why',
    used?.structure?.editable === false &&
      /postings?/.test(used?.structure?.reason ?? ''),
    used?.structure,
  );
  const back = await req('PATCH', `/accounts/${meezan.id}`, {
    type: 'expense',
    subType: 'Other Expense',
  });
  ok(
    'C7 turning it back into an expense is refused (ACCOUNT_IN_USE), naming what holds it',
    back.status === 400 &&
      codeOf(back) === 'ACCOUNT_IN_USE' &&
      /posting/.test(messageOf(back)),
    back.body,
  );
  const renamed = await req('PATCH', `/accounts/${meezan.id}`, {
    name: `Meezan Bank ${RUN}`,
  });
  ok(
    'C8 renaming it is still fine',
    renamed.status === 200 && data(renamed)?.name === `Meezan Bank ${RUN}`,
    renamed.body,
  );

  const sysType = await req('PATCH', `/accounts/${checking.id}`, {
    type: 'expense',
    subType: 'Operating',
  });
  const sysKind = await req('PATCH', `/accounts/${checking.id}`, {
    subType: 'Other Asset',
  });
  const sysNumber = await req('PATCH', `/accounts/${checking.id}`, {
    accountNumber: await freeNumber(1010, 1099),
  });
  ok(
    'C9 1010 Business Checking: type, kind and number are fixed (SYSTEM_ACCOUNT_FIXED)',
    [sysType, sysKind, sysNumber].every(
      (r) => r.status === 400 && codeOf(r) === 'SYSTEM_ACCOUNT_FIXED',
    ),
    [sysType.body, sysKind.body, sysNumber.body],
  );
  const sysRename = await req('PATCH', `/accounts/${checking.id}`, {
    name: checking.name,
  });
  ok(
    'C10 …but it can still be renamed',
    sysRename.status === 200,
    sysRename.body,
  );

  const spare = data(
    await req('POST', '/accounts', {
      accountNumber: await freeNumber(6500, 6999),
      name: `Spare ${RUN}`,
      type: 'expense',
      subType: 'Operating',
    }),
  );
  const clash = await req('PATCH', `/accounts/${spare.id}`, {
    type: 'asset',
    subType: 'Bank',
    accountNumber: mcb.accountNumber,
  });
  ok(
    'C11 a number another account has is refused, naming that account',
    clash.status === 409 &&
      codeOf(clash) === 'DUPLICATE_ACCOUNT_NUMBER' &&
      messageOf(clash).includes('MCB'),
    clash.body,
  );
  await req('DELETE', `/accounts/${spare.id}`);

  // ═══════════════════════════════════════════════════════════════
  console.log('\n— D. tax paid from a bank');
  const rate = data(
    await req('POST', '/taxes/rates', {
      name: `Bank WHT ${RUN}`,
      rate: '0',
      taxType: 'payroll',
    }),
  );
  ok('tax rate ready', !!rate?.id, rate);
  const mcbBeforeTax = await balance(mcb.id);
  const cashBeforeTax = await balance(cash.id);
  const taxRes = await req('POST', '/taxes/payments', {
    taxRateId: rate.id,
    period: `BA ${RUN}`,
    amount: '12000',
    paymentDate: TODAY,
    bankAccountId: mcb.id,
  });
  const tax = data(taxRes);
  ok(
    'D1 a tax payment from MCB credits MCB, not Cash, and remembers MCB',
    taxRes.status < 400 &&
      tax?.bankAccountId === mcb.id &&
      near(await posted(mcb.id, tax.id), -12000) &&
      near(await balance(mcb.id), mcbBeforeTax - 12000) &&
      near(await balance(cash.id), cashBeforeTax),
    taxRes.body,
  );
  const deleted = await req('DELETE', `/taxes/payments/${tax.id}`);
  ok(
    'D2 deleting it puts the 12,000 back in MCB',
    deleted.status < 400 &&
      near(await balance(mcb.id), mcbBeforeTax) &&
      near(await posted(mcb.id, tax.id), 0),
    deleted.body,
  );
  const plain = data(
    await req('POST', '/taxes/payments', {
      taxRateId: rate.id,
      period: `BA ${RUN} cash`,
      amount: '700',
      paymentDate: TODAY,
    }),
  );
  ok(
    'D3 with no account chosen it is paid from 1000 Cash, as before',
    plain?.bankAccountId === cash.id &&
      near(await posted(cash.id, plain.id), -700),
    plain,
  );
  const { rows: taxCount } = await db.query(
    `SELECT COUNT(*)::int c FROM tax_payments WHERE company_id = $1`,
    [COMPANY],
  );
  const badTax = await req('POST', '/taxes/payments', {
    taxRateId: rate.id,
    period: `BA ${RUN} bad`,
    amount: '100',
    paymentDate: TODAY,
    bankAccountId: (chart.find((a: any) => a.accountNumber === '6000') ?? {})
      .id,
  });
  const { rows: taxCountAfter } = await db.query(
    `SELECT COUNT(*)::int c FROM tax_payments WHERE company_id = $1`,
    [COMPANY],
  );
  ok(
    'D4 an expense account is refused, and nothing is written',
    badTax.status === 400 &&
      codeOf(badTax) === 'INVALID_PAYMENT_ACCOUNT' &&
      taxCount[0].c === taxCountAfter[0].c,
    badTax.body,
  );

  // ═══════════════════════════════════════════════════════════════
  console.log('\n— E. payroll paid from a bank');
  const emp = data(
    await req('POST', '/employees', {
      firstName: 'Bank',
      lastName: `Payee ${RUN}`,
      payType: 'salary',
      salary: '240000',
      payFrequency: 'monthly',
    }),
  );
  ok('employee ready', !!emp?.id, emp);
  const run = data(
    await req('POST', '/payroll/runs', {
      payPeriod: `BA ${RUN}`,
      periodStart: TODAY,
      periodEnd: TODAY,
      payDate: TODAY,
      items: [{ employeeId: emp.id }],
    }),
  );
  ok('payroll run drafted', run?.status === 'draft', run);

  const closedRes = await req('POST', '/accounts', {
    accountNumber: await freeNumber(1010, 1099),
    name: `Closed Bank ${RUN}`,
    type: 'asset',
    subType: 'Bank',
  });
  const closed = data(closedRes);
  await req('PATCH', `/accounts/${closed.id}/toggle`);
  const refusedRun = await req('POST', `/payroll/runs/${run.id}/process`, {
    bankAccountId: closed.id,
  });
  const stillDraft = data(await req('GET', `/payroll/runs/${run.id}`)) as any;
  ok(
    'E1 an inactive bank is refused, and the run stays a draft',
    refusedRun.status === 400 &&
      codeOf(refusedRun) === 'INVALID_PAYMENT_ACCOUNT' &&
      stillDraft?.status === 'draft',
    refusedRun.body,
  );
  const alliedBeforePay = await balance(allied.id);
  const cashBeforePay = await balance(cash.id);
  const processed = await req('POST', `/payroll/runs/${run.id}/process`, {
    bankAccountId: allied.id,
  });
  const paidRun = data(processed);
  ok(
    'E2 processed from Allied: net pay leaves Allied, not Cash, and the run remembers it',
    processed.status < 400 &&
      paidRun?.status === 'paid' &&
      paidRun?.bankAccountId === allied.id &&
      near(await balance(allied.id), alliedBeforePay - n(paidRun?.totalNet)) &&
      near(await balance(cash.id), cashBeforePay),
    processed.body,
  );

  const run2 = data(
    await req('POST', '/payroll/runs', {
      payPeriod: `BA ${RUN} cash`,
      periodStart: TODAY,
      periodEnd: TODAY,
      payDate: TODAY,
      items: [{ employeeId: emp.id }],
    }),
  );
  const cashBeforeRun2 = await balance(cash.id);
  // As an older app sends it: no body at all.
  const processedCash = await req('POST', `/payroll/runs/${run2.id}/process`);
  ok(
    'E3 processed with no account chosen: net pay leaves 1000 Cash, as before',
    processedCash.status < 400 &&
      data(processedCash)?.bankAccountId === cash.id &&
      near(
        await balance(cash.id),
        cashBeforeRun2 - n(data(processedCash)?.totalNet),
      ),
    processedCash.body,
  );

  // ═══════════════════════════════════════════════════════════════
  console.log('\n— F. credit-memo refunds from a bank');
  const memo = async (amount: number, extra: Record<string, unknown> = {}) => {
    const res = await req('POST', '/credit-memos', {
      customerId: customer.id,
      date: TODAY,
      reason: 'bank account acceptance',
      lines: [
        {
          description: 'Goodwill',
          quantity: '1',
          unitPrice: String(amount),
          taxRate: '0',
        },
      ],
      ...extra,
    });
    return { res, memo: data(res) };
  };
  const { memo: cm1 } = await memo(25000);
  const wrong = await req('POST', `/credit-memos/${cm1.id}/refund`, {
    bankAccountId: '00000000-0000-4000-8000-000000000000',
  });
  const cm1Open = data(await req('GET', `/credit-memos/${cm1.id}`)) as any;
  ok(
    'F1 an account that is not this company’s is refused, and the memo stays open',
    wrong.status === 404 &&
      codeOf(wrong) === 'ACCOUNT_NOT_FOUND' &&
      cm1Open?.status === 'open',
    wrong.body,
  );
  const mcbBeforeRefund = await balance(mcb.id);
  const refunded = await req('POST', `/credit-memos/${cm1.id}/refund`, {
    bankAccountId: mcb.id,
  });
  ok(
    'F2 refunded from MCB: 25,000 leaves MCB and the memo says "refunded from" MCB',
    refunded.status < 400 &&
      data(refunded)?.status === 'refunded' &&
      data(refunded)?.refundAccountId === mcb.id &&
      near(await balance(mcb.id), mcbBeforeRefund - 25000),
    refunded.body,
  );

  const { memo: reversal } = await memo(4000, {
    refundRemainderToCash: true,
    refundAccountId: mcb.id,
  });
  ok(
    'F3 a reversal that refunds its remainder uses the account it was given',
    reversal?.status === 'refunded' &&
      reversal?.refundAccountId === mcb.id &&
      near(await posted(mcb.id, reversal.id), -4000),
    reversal,
  );
  const { memo: legacy } = await memo(300);
  const legacyRefund = await req('POST', `/credit-memos/${legacy.id}/refund`);
  ok(
    'F4 a refund with no body still comes out of 1000 Cash',
    legacyRefund.status < 400 &&
      data(legacyRefund)?.refundAccountId === cash.id &&
      near(await posted(cash.id, legacy.id), -300),
    legacyRefund.body,
  );

  const staffUser = `bank.staff.${RUN}`;
  const staff = await req('POST', '/settings/users', {
    name: 'Bank Staff',
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
    const { memo: cm2 } = await memo(6000);
    const rent = chart.find((a: any) => a.accountNumber === '6000');
    const badAsk = await req(
      'POST',
      `/credit-memos/${cm2.id}/refund`,
      { bankAccountId: rent?.id },
      ST,
    );
    ok(
      'F5 staff asking to refund from an expense are refused before the owner sees it',
      badAsk.status === 400 && codeOf(badAsk) === 'INVALID_PAYMENT_ACCOUNT',
      badAsk.body,
    );
    const asked = await req(
      'POST',
      `/credit-memos/${cm2.id}/refund`,
      { bankAccountId: allied.id },
      ST,
    );
    const pending = data(asked) as any;
    ok(
      'F6 a staff refund is filed for the owner, naming Allied',
      pending?.pending === true &&
        String(pending?.summary ?? '').includes(`Allied Bank ${RUN}`),
      asked.body,
    );
    const alliedBeforeApproval = await balance(allied.id);
    const decided = await req(
      'POST',
      `/approvals/${pending?.requestId}/decide`,
      { decision: 'approve' },
    );
    const cm2After = data(await req('GET', `/credit-memos/${cm2.id}`)) as any;
    ok(
      'F7 approved, the 6,000 leaves Allied',
      decided.status === 200 &&
        cm2After?.status === 'refunded' &&
        cm2After?.refundAccountId === allied.id &&
        near(await balance(allied.id), alliedBeforeApproval - 6000),
      decided.body,
    );
    await req('PATCH', `/settings/users/${data(staff)?.id}/deactivate`);
  } else {
    console.log(`    (no staff seat free — skipped F5–F7: ${codeOf(staff)})`);
  }

  // ═══════════════════════════════════════════════════════════════
  console.log('\n— G. reports');
  const unrec = data(
    await req('GET', `/reconciliations/unreconciled?accountId=${mcb.id}`),
  ) as any;
  const sources = (unrec?.entries ?? []).map((e: any) => e.sourceType);
  ok(
    'G1 MCB’s reconciliation lists its bill payment, tax payment and refunds',
    ['bill_payment', 'tax_payment', 'credit_memo_refund'].every((s) =>
      sources.includes(s),
    ),
    sources,
  );
  const flow = data(
    await req(
      'GET',
      `/reports/cash-flow?startDate=1970-01-01&endDate=${TODAY}`,
    ),
  ) as any;
  const { rows: money } = await db.query(
    `SELECT COALESCE(SUM(g.debit - g.credit), 0) AS v
       FROM general_ledger g JOIN accounts a ON a.id = g.account_id
      WHERE g.company_id = $1 AND a.sub_type IN ('Cash', 'Bank') AND g.date <= $2`,
    [COMPANY, TODAY],
  );
  ok(
    'G2 the cash flow ends on every cash and bank account together',
    near(n(flow?.endingCash), Math.round(n(money[0]?.v) * 100) / 100, 0.01),
    { endingCash: flow?.endingCash, books: money[0]?.v },
  );
  const tb = data(
    await req(
      'GET',
      '/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31',
    ),
  ) as any;
  ok('G3 the trial balance balances', tb?.isBalanced === true, tb?.totalDebits);

  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('Failed:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
