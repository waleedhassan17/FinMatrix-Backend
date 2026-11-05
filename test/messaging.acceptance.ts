/**
 * FinMatrix Connect — WhatsApp delivery acceptance (fake provider)
 * ================================================================
 * Drives the running API (WHATSAPP_ENABLED=false, worker on) as the
 * warehouse owner and a staff member, reads the database directly, and boots
 * an application context in THIS process (worker off) to run the crons and to
 * roll a posting back on purpose.
 *
 *   1. posting an invoice queues one row and it reaches "read"; "Post only"
 *      sends nothing; a rolled-back posting queues none
 *   2. staff PO request: no PO message on request or on approval (draft), one
 *      on draft -> sent; "Don't send"; withdrawing it tells the vendor
 *   3. staff bill payment: none on request, one remittance after approval; a
 *      racing double approval still gives one
 *   4. settle() with credit + cash gives ONE remittance (and credit-only one)
 *   5. void cancels queued messages and queues the cancellation (only if the
 *      customer had the invoice)
 *   6. opted out, no number, rule off, no consent (and feature off) give
 *      'skipped' with the reason
 *   7. webhook: bad signature 401, statuses only move forward, STOP opts out
 *   8. dunning at the configured offsets, none after full payment, quiet
 *      hours defer to 09:00 company time, approval alerts ignore quiet hours
 *   9. the ledger invariants show nothing new
 *
 * Usage: boot the API with WHATSAPP_ENABLED=false and WHATSAPP_APP_SECRET set,
 * then (same secret):
 *   API_BASE=http://localhost:3100/api/v1 DATABASE_URL=postgres://… DB_SSL=false \
 *   WHATSAPP_APP_SECRET=… npm run test:messaging
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { Client } = require('pg');
import { createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';

process.env.MESSAGING_WORKER_ENABLED = 'false'; // the in-process context must not dispatch
process.env.BILLING_CRON = 'off';

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';
const SECRET = process.env.WHATSAPP_APP_SECRET || '';
const KNOWN_INVARIANTS = (process.env.KNOWN_INVARIANT_VIOLATIONS || 'I13')
  .split(',')
  .map((s) => s.trim());
const RUN = String(Date.now());

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
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : ''}`,
    );
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let TOKEN = '';
let COMPANY = '';

async function req(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
  raw = false,
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
      body:
        body === undefined
          ? undefined
          : typeof body === 'string'
            ? body
            : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 3) {
      await sleep(path.startsWith('/auth') ? 65_000 : 15_000 * (attempt + 1));
      continue;
    }
    if (raw) return { status: res.status, body: null as any, res };
    let parsed: any = null;
    try {
      parsed = await res.json();
    } catch {
      /* empty */
    }
    return { status: res.status, body: parsed, res };
  }
}
const data = (r: { body: any }) => r.body?.data ?? r.body;
const codeOf = (r: { body: any }) =>
  r.body?.error?.code ?? r.body?.code ?? r.body?.data?.code;

async function waitFor<T>(
  fn: () => Promise<T>,
  done: (v: T) => boolean,
  ms = 30_000,
): Promise<T> {
  const until = Date.now() + ms;
  let v = await fn();
  while (!done(v) && Date.now() < until) {
    await sleep(750);
    v = await fn();
  }
  return v;
}

/** Wall clock in a time zone (for offsets and the 09:00 expectation). */
function zoned(now: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const p: Record<string, number> = {};
  for (const x of parts) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return p as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
  };
}

async function main() {
  if (!DB) throw new Error('DATABASE_URL is required');
  if (!SECRET)
    throw new Error(
      'WHATSAPP_APP_SECRET is required (the same value the API runs with)',
    );
  const db = new Client({ connectionString: DB, ssl: false });
  await db.connect();
  console.log(`\nFinMatrix Connect — WhatsApp delivery → ${API}\n`);

  const login = await req('POST', '/auth/signin', {
    email: EMAIL,
    password: PASSWORD,
  });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  const OWNER_ID: string = data(login)?.user?.id ?? '';
  ok('owner signs in', !!TOKEN && !!COMPANY && !!OWNER_ID, login.status);
  if (!TOKEN) throw new Error('cannot sign in');
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  // ── DB readers ──────────────────────────────────────────────────
  const msgs = async (docType: string, docId: string, event?: string) =>
    (
      await db.query(
        `SELECT * FROM outbound_messages WHERE company_id = $1 AND doc_type = $2 AND doc_id = $3
           ${event ? 'AND event_type = $4' : ''} ORDER BY created_at`,
        event ? [COMPANY, docType, docId, event] : [COMPANY, docType, docId],
      )
    ).rows as any[];
  const msgById = async (id: string) =>
    (await db.query(`SELECT * FROM outbound_messages WHERE id = $1`, [id]))
      .rows[0] as any;
  const forRecipient = async (
    recipientId: string,
    docType?: string,
    event?: string,
  ) =>
    (
      await db.query(
        `SELECT * FROM outbound_messages WHERE company_id = $1 AND recipient_id = $2
           ${docType ? `AND doc_type = '${docType}'` : ''} ${event ? `AND event_type = '${event}'` : ''}
          ORDER BY created_at`,
        [COMPANY, recipientId],
      )
    ).rows as any[];
  const waitStatus = (id: string, statuses: string[], ms = 30_000) =>
    waitFor(
      () => msgById(id),
      (m) => !!m && statuses.includes(m.status),
      ms,
    );
  const SENT = ['sent', 'delivered', 'read'];

  // ── 0. Connect on, no quiet hours while we work ─────────────────
  console.log('— 0. switch Connect on');
  const put = await req('PUT', '/settings/messaging', {
    enabled: true,
    quietHours: null,
    defaultLanguage: 'en',
    monthlyCap: null,
    reminderSchedule: { beforeDue: [3], afterDue: [0, 7] },
    eventRules: {
      invoice_issued: 'auto',
      invoice_cancelled: 'auto',
      payment_received: 'auto',
      po_issued: 'auto',
      po_cancelled: 'auto',
      remittance: 'auto',
      approval_pending: 'auto',
      reminder_upcoming: 'auto',
      reminder_overdue: 'auto',
    },
  });
  const settings = data(put);
  ok(
    '0a owner switches Connect on',
    put.status === 200 && settings?.enabled === true,
    put.body,
  );
  ok(
    '0b the token is never returned',
    settings &&
      !('accessTokenEnc' in settings) &&
      settings.accessTokenSet === false,
  );
  const TZ: string = settings?.timezone || 'Asia/Karachi';
  const consentAll = !!settings?.contactsOptInConfirmedAt;
  const z = zoned(new Date(), TZ);
  const TODAY = `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;
  const day = (n: number) => {
    const d = new Date(Date.UTC(z.year, z.month - 1, z.day + n));
    return d.toISOString().slice(0, 10);
  };

  // ── masters ─────────────────────────────────────────────────────
  const tail = RUN.slice(-7);
  const mk = async (path: string, body: Record<string, unknown>) =>
    data(await req('POST', path, body));
  const custA = await mk('/customers', {
    name: `Connect A ${RUN}`,
    phone: `0300${tail}`,
    whatsappOptIn: true,
  });
  const custNoNum = await mk('/customers', { name: `Connect NoNumber ${RUN}` });
  const custNoConsent = await mk('/customers', {
    name: `Connect NoConsent ${RUN}`,
    phone: `0301${tail}`,
  });
  const custStop = await mk('/customers', {
    name: `Connect Stop ${RUN}`,
    phone: `0302${tail}`,
    whatsappOptIn: true,
  });
  const custBad = await mk('/customers', {
    name: `Connect Undeliverable ${RUN}`,
    phone: `0303${tail.slice(-3)}0000`,
    whatsappOptIn: true,
  });
  const vendor = await mk('/vendors', {
    companyName: `Connect Vendor ${RUN}`,
    contactPerson: 'Bilal',
    phone: `0304${tail}`,
    whatsappOptIn: true,
  });
  ok(
    'masters created; the WhatsApp number is derived from the phone',
    custA?.whatsappE164 === `+92300${tail}` &&
      !!vendor?.id &&
      custNoNum?.whatsappE164 == null,
    { a: custA?.whatsappE164, v: vendor?.id },
  );
  const bad = await req('POST', '/customers', {
    name: `Bad ${RUN}`,
    whatsappPhone: '12345',
  });
  ok(
    'an unusable WhatsApp number is refused (400 INVALID_WHATSAPP_NUMBER)',
    bad.status === 400 && codeOf(bad) === 'INVALID_WHATSAPP_NUMBER',
    bad.body,
  );

  const accounts =
    (data(await req('GET', '/accounts?limit=500')) as any)?.accounts ??
    data(await req('GET', '/accounts'));
  const list: any[] = Array.isArray(accounts)
    ? accounts
    : (accounts?.accounts ?? []);
  const cashAcct = list.find((a) => a.accountNumber === '1000');
  const expenseAcct = list.find((a) => a.type === 'expense');
  ok('cash and an expense account found', !!cashAcct?.id && !!expenseAcct?.id);

  const makeInvoice = async (
    customerId: string,
    label: string,
    dueDate: string,
    price = 1000,
    status = 'sent',
  ) => {
    const r = await req('POST', '/invoices', {
      customerId,
      invoiceDate: TODAY,
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
      console.log(
        `    (invoice ${label} refused: ${JSON.stringify(r.body).slice(0, 300)})`,
      );
    return data(r);
  };
  const makeBill = async (label: string, amount: number) =>
    data(
      await req('POST', '/bills', {
        vendorId: vendor.id,
        billNumber: `CON-${RUN}-${label}`,
        billDate: TODAY,
        dueDate: day(20),
        status: 'open',
        lines: [
          {
            description: label,
            amount: String(amount),
            taxRate: '0',
            accountId: expenseAcct?.id,
          },
        ],
      }),
    );
  const PNG = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
  );
  const uploadProof = async (token = TOKEN) => {
    const fd = new FormData();
    fd.append(
      'proof',
      new Blob([PNG as unknown as BlobPart], { type: 'image/png' }),
      'proof.png',
    );
    const r = await fetch(`${API}/bill-payments/proofs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'x-company-id': COMPANY },
      body: fd as any,
    });
    const body: any = await r.json().catch(() => null);
    return (body?.data ?? body)?.id as string;
  };

  // ── in-process context (crons, a forced rollback, feature-off) ──
  const { NestFactory } = require('@nestjs/core');
  const { AppModule } = require('../src/app.module');
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  const { DataSource } = require('typeorm');
  const {
    InvoicesService,
  } = require('../src/modules/invoices/invoices.service');
  const {
    DunningCronService,
  } = require('../src/modules/messaging/dunning-cron.service');
  const {
    MessagingService,
  } = require('../src/modules/messaging/messaging.service');
  const ds = app.get(DataSource);

  // ══ 1. Posting an invoice ═══════════════════════════════════════
  console.log('\n— 1. posting an invoice');
  const inv1 = await makeInvoice(custA.id, 'Issue', day(10));
  const issue = await msgs('invoice', inv1?.id, 'invoice_issued');
  ok(
    '1a posting an invoice queues exactly one row',
    issue.length === 1,
    issue.map((m) => m.status),
  );
  const read1 = await waitStatus(issue[0]?.id, ['read', 'failed']);
  ok(
    '1b the fake provider takes it to "read"',
    read1?.status === 'read',
    read1?.status,
  );
  const tl = data(
    await req('GET', `/messages?docType=invoice&docId=${inv1?.id}`),
  );
  const evs = (tl?.messages?.[0]?.events ?? []).map((e: any) => e.status);
  ok(
    '1c the timeline shows sent → delivered → read',
    ['sent', 'delivered', 'read'].every((s) => evs.includes(s)),
    evs,
  );
  ok(
    '1d the timeline masks the number',
    /^\+92300\*\*\*\d{4}$/.test(tl?.messages?.[0]?.toPhoneMasked ?? ''),
    tl?.messages?.[0]?.toPhoneMasked,
  );
  const verified = (
    await db.query(`SELECT whatsapp_verified_at FROM customers WHERE id = $1`, [
      custA.id,
    ])
  ).rows[0];
  ok(
    '1e "delivered" verifies the customer\'s number',
    !!verified?.whatsapp_verified_at,
  );
  const media = await req(
    'GET',
    `/messages/${issue[0]?.id}/media`,
    undefined,
    undefined,
    true,
  );
  const pdf = Buffer.from(await media.res.arrayBuffer());
  ok(
    '1f "View PDF sent" returns the PDF that went',
    media.status === 200 && pdf.subarray(0, 4).toString() === '%PDF',
    media.status,
  );
  const detail = data(await req('GET', `/invoices/${inv1?.id}`));
  ok(
    '1g lastMessageStatus on the invoice detail',
    detail?.lastMessageStatus?.status === 'read',
    detail?.lastMessageStatus,
  );
  const listed = await req('GET', `/invoices?customerId=${custA.id}&limit=100`);
  const row =
    (data(listed) as any[])?.find?.((i: any) => i.id === inv1?.id) ??
    (listed.body?.data ?? []).find?.((i: any) => i.id === inv1?.id);
  ok(
    '1h lastMessageStatus on the invoice list',
    !!row && row.lastMessageStatus?.status === 'read',
    row?.lastMessageStatus,
  );

  const draftQuiet = await makeInvoice(
    custA.id,
    'PostOnly',
    day(10),
    500,
    'draft',
  );
  const postOnly = await req('POST', `/invoices/${draftQuiet?.id}/send`, {
    deliver: { whatsapp: false },
  });
  ok(
    '1i "Post only" posts and sends nothing',
    postOnly.status === 200 &&
      (await msgs('invoice', draftQuiet?.id)).length === 0,
    postOnly.body,
  );
  const draftSend = await makeInvoice(
    custA.id,
    'PostSend',
    day(10),
    500,
    'draft',
  );
  await req('POST', `/invoices/${draftSend?.id}/send`, {});
  ok(
    '1j "Post & send" queues one',
    (await msgs('invoice', draftSend?.id, 'invoice_issued')).length === 1,
  );

  const beforeLock = (await forRecipient(custA.id)).length;
  await req('POST', `/companies/${COMPANY}/period-close`, {
    lockDate: day(-60),
  });
  const locked = await req('POST', '/invoices', {
    customerId: custA.id,
    invoiceDate: day(-90),
    dueDate: day(-80),
    status: 'sent',
    lines: [
      {
        description: 'Locked',
        quantity: '1',
        unitPrice: '10',
        taxRate: '0',
        lineKind: 'service',
      },
    ],
  });
  await req('POST', `/companies/${COMPANY}/period-reopen`);
  ok(
    '1k a posting refused by the period lock queues nothing',
    locked.status >= 400 &&
      (await forRecipient(custA.id)).length === beforeLock,
    locked.status,
  );

  const rolledNumber = `RB-${RUN}`;
  let rolledBack = false;
  try {
    await ds.transaction(async (m: any) => {
      await app.get(InvoicesService).createInTransaction(m, COMPANY, OWNER_ID, {
        customerId: custA.id,
        invoiceNumber: rolledNumber,
        invoiceDate: TODAY,
        dueDate: day(5),
        status: 'sent',
        lines: [
          {
            description: 'Rolled back',
            quantity: '1',
            unitPrice: '10',
            taxRate: '0',
            lineKind: 'service',
          },
        ],
      });
      const inside = await m.query(
        `SELECT count(*)::int AS n FROM outbound_messages WHERE recipient_id = $1`,
        [custA.id],
      );
      if (inside[0].n <= beforeLock)
        throw new Error('the row was not written inside the transaction');
      throw new Error('force rollback');
    });
  } catch (e) {
    rolledBack = (e as Error).message === 'force rollback';
  }
  ok(
    '1l a posting rolled back after its enqueue leaves no row (the row lives in the posting transaction)',
    rolledBack && (await forRecipient(custA.id)).length === beforeLock,
    { rolledBack },
  );

  // ══ staff member ════════════════════════════════════════════════
  const staffUser = `connect.staff.${RUN}`;
  let staff = await req('POST', '/settings/users', {
    name: 'Connect Staff',
    username: staffUser,
    password: 'Test1234!',
    role: 'staff',
  });
  if (codeOf(staff) === 'STAFF_LIMIT_REACHED') {
    // The company's one staff seat is taken (throwaway copy): free it.
    const users = (data(await req('GET', '/settings/users')) as any[]) ?? [];
    for (const u of users.filter(
      (x) => x.role === 'staff' && x.status === 'active',
    )) {
      await req('PATCH', `/settings/users/${u.id}/deactivate`);
    }
    staff = await req('POST', '/settings/users', {
      name: 'Connect Staff',
      username: staffUser,
      password: 'Test1234!',
      role: 'staff',
    });
  }
  const staffLogin = await req('POST', '/auth/signin', {
    email: staffUser,
    password: 'Test1234!',
  });
  const ST: string = data(staffLogin)?.tokens?.accessToken ?? '';
  ok('a staff member signs in', !!ST, staffLogin.body);

  // ══ 2. Staff PO request ═════════════════════════════════════════
  console.log('\n— 2. a staff purchase order');
  const poBody = {
    vendorId: vendor.id,
    orderDate: TODAY,
    expectedDate: day(7),
    lines: [
      {
        description: 'Crates',
        orderedQty: '5',
        unitCost: '100',
        accountId: expenseAcct?.id,
      },
    ],
  };
  const poAsk = await req('POST', '/purchase-orders', poBody, ST);
  const poPending = data(poAsk) as any;
  ok(
    '2a a staff PO is filed for approval',
    poPending?.pending === true && !!poPending?.requestId,
    poAsk.body,
  );
  ok(
    '2b no PO message on the request',
    (await forRecipient(vendor.id, 'purchase_order')).length === 0,
  );
  const alerts = await msgs('approval_request', poPending?.requestId);
  ok(
    '2c the owners get an approval alert (one per admin)',
    alerts.length >= 1 && alerts.every((a) => a.recipient_type === 'user'),
    alerts.length,
  );
  const poDecided = await req(
    'POST',
    `/approvals/${poPending?.requestId}/decide`,
    { decision: 'approve' },
  );
  const poId = data(poDecided)?.resultId;
  ok(
    '2d the owner approves: the PO exists as a draft',
    poDecided.status === 200 && !!poId,
    poDecided.body,
  );
  ok(
    '2e still no PO message (a draft is a requisition)',
    (await forRecipient(vendor.id, 'purchase_order')).length === 0,
  );
  await req('PATCH', `/purchase-orders/${poId}/status`, { status: 'sent' });
  const poMsgs = await msgs('purchase_order', poId, 'po_issued');
  ok(
    '2f draft → sent sends the PO to the vendor (one row)',
    poMsgs.length === 1,
    poMsgs.length,
  );
  ok(
    '2g the vendor is greeted by contact person',
    poMsgs[0]?.params?.recipientName === 'Bilal',
    poMsgs[0]?.params,
  );
  const po2 = data(await req('POST', '/purchase-orders', poBody));
  await req('PATCH', `/purchase-orders/${po2?.id}/status`, {
    status: 'sent',
    deliver: { whatsapp: false },
  });
  ok(
    '2h "Don\'t send" marks it sent and sends nothing',
    (await msgs('purchase_order', po2?.id)).length === 0,
  );
  await waitStatus(poMsgs[0]?.id, SENT);
  await req('PATCH', `/purchase-orders/${poId}/status`, { status: 'draft' });
  ok(
    '2i withdrawing a PO the vendor had tells them (po_cancelled)',
    (await msgs('purchase_order', poId, 'po_cancelled')).length === 1,
  );

  // ══ 3. Staff bill payment ═══════════════════════════════════════
  console.log('\n— 3. a staff bill payment');
  const bill1 = await makeBill('B1', 500);
  const bill2 = await makeBill('B2', 300);
  const remitBefore = (await forRecipient(vendor.id, undefined, 'remittance'))
    .length;
  const payAsk = await req(
    'POST',
    '/bills/pay',
    {
      vendorId: vendor.id,
      paymentDate: TODAY,
      paymentMethod: 'cash',
      bankAccountId: cashAcct?.id,
      proofId: await uploadProof(ST),
      applications: [{ billId: bill1?.id, amount: '200' }],
    },
    ST,
  );
  const payPending = data(payAsk) as any;
  ok(
    '3a a staff bill payment is filed for approval',
    payPending?.pending === true,
    payAsk.body,
  );
  ok(
    '3b no remittance on the request',
    (await forRecipient(vendor.id, undefined, 'remittance')).length ===
      remitBefore,
  );
  const payDecided = await req(
    'POST',
    `/approvals/${payPending?.requestId}/decide`,
    { decision: 'approve' },
  );
  ok(
    '3c one remittance after approval',
    payDecided.status === 200 &&
      (await forRecipient(vendor.id, undefined, 'remittance')).length ===
        remitBefore + 1,
    payDecided.body,
  );
  const race = data(
    await req(
      'POST',
      '/bills/pay',
      {
        vendorId: vendor.id,
        paymentDate: TODAY,
        paymentMethod: 'cash',
        bankAccountId: cashAcct?.id,
        proofId: await uploadProof(ST),
        applications: [{ billId: bill2?.id, amount: '100' }],
      },
      ST,
    ),
  ) as any;
  const both = await Promise.all([
    req('POST', `/approvals/${race?.requestId}/decide`, {
      decision: 'approve',
    }),
    req('POST', `/approvals/${race?.requestId}/decide`, {
      decision: 'approve',
    }),
  ]);
  const approvedCount = both.filter(
    (r) => r.status === 200 && data(r)?.status === 'approved',
  ).length;
  ok(
    '3d a racing double approval approves once and sends one remittance',
    approvedCount === 1 &&
      (await forRecipient(vendor.id, undefined, 'remittance')).length ===
        remitBefore + 2,
    both.map((r) => r.status),
  );

  // ══ 4. settle() credit + cash ═══════════════════════════════════
  console.log('\n— 4. settling from credit and cash');
  const bill3 = await makeBill('B3', 400);
  const vc = data(
    await req('POST', '/vendor-credits', {
      vendorId: vendor.id,
      date: TODAY,
      reason: 'connect',
      lines: [
        {
          description: 'Return',
          amount: '100',
          taxRate: '0',
          accountId: expenseAcct?.id,
        },
      ],
    }),
  ) as any;
  const settle = await req('POST', '/bills/settle', {
    vendorId: vendor.id,
    paymentDate: TODAY,
    credits: [{ vendorCreditId: vc?.id, billId: bill3?.id, amount: '100' }],
    cash: {
      paymentMethod: 'cash',
      bankAccountId: cashAcct?.id,
      proofId: await uploadProof(),
      applications: [{ billId: bill3?.id, amount: '300' }],
    },
  });
  const sp = data(settle) as any;
  const settleMsgs = await msgs('bill_payment', sp?.payment?.id, 'remittance');
  ok(
    '4a settle with credit + cash sends ONE remittance',
    settle.status === 200 && settleMsgs.length === 1,
    settle.body,
  );
  ok(
    '4b it covers credit + cash (Rs 400.00) and names the credit',
    settleMsgs[0]?.params?.amount === 'Rs 400.00' &&
      settleMsgs[0]?.attachment?.args?.credits?.length === 1,
    settleMsgs[0]?.params,
  );
  const bill4 = await makeBill('B4', 50);
  const vc2 = data(
    await req('POST', '/vendor-credits', {
      vendorId: vendor.id,
      date: TODAY,
      reason: 'connect',
      lines: [
        {
          description: 'Return',
          amount: '50',
          taxRate: '0',
          accountId: expenseAcct?.id,
        },
      ],
    }),
  ) as any;
  const settlementsBefore = (await forRecipient(vendor.id, 'bill_settlement'))
    .length;
  await req('POST', '/bills/settle', {
    vendorId: vendor.id,
    paymentDate: TODAY,
    credits: [{ vendorCreditId: vc2?.id, billId: bill4?.id, amount: '50' }],
  });
  ok(
    '4c a credit-only settlement sends one advice too',
    (await forRecipient(vendor.id, 'bill_settlement')).length ===
      settlementsBefore + 1,
  );

  // ══ 5 + 8. quiet hours on: void, deferral, dunning ══════════════
  console.log('\n— 5. void, with quiet hours holding messages');
  const nowZ = zoned(new Date(), TZ);
  const startMin = nowZ.hour * 60 + nowZ.minute - 1;
  const hh = (m: number) =>
    `${String(Math.floor(((m + 1440) % 1440) / 60)).padStart(2, '0')}:${String(((m + 1440) % 1440) % 60).padStart(2, '0')}`;
  const qStart = hh(startMin);
  // 09:00 is the end; when "now" is 08:59 or 09:00 the window would be empty, so shift.
  const qEnd = nowZ.hour === 9 && nowZ.minute <= 1 ? '09:30' : '09:00';
  const qPut = await req('PUT', '/settings/messaging', {
    quietHours: { start: qStart, end: qEnd },
  });
  ok(
    'quiet hours set to start now and end at 09:00 company time',
    qPut.status === 200,
    qPut.body,
  );

  const remind = data(
    await req('POST', '/messages/send', {
      docType: 'invoice',
      docId: inv1?.id,
      event: 'reminder',
    }),
  ) as any;
  ok(
    '5a "Send reminder" queues a reminder',
    remind?.status === 'queued',
    remind,
  );
  const deferred = await waitFor(
    () => msgById(remind?.id),
    (m) => !!m?.scheduled_for,
    15_000,
  );
  const [eh, em] = qEnd.split(':').map(Number);
  const nz = zoned(new Date(), TZ);
  const endToday = Date.UTC(nz.year, nz.month - 1, nz.day, eh, em);
  // Asia/Karachi has no DST: local = UTC + offset, offset measured now.
  const offsetMs =
    Date.UTC(nz.year, nz.month - 1, nz.day, nz.hour, nz.minute) -
    Math.floor(Date.now() / 60_000) * 60_000;
  const nowLocal = Date.UTC(nz.year, nz.month - 1, nz.day, nz.hour, nz.minute);
  const expectedLocal = nowLocal < endToday ? endToday : endToday + 86_400_000;
  const expectedUtc = new Date(expectedLocal - offsetMs).toISOString();
  ok(
    `8a quiet hours hold it until ${qEnd} company time`,
    deferred?.status === 'queued' &&
      new Date(deferred?.scheduled_for).toISOString() === expectedUtc,
    {
      status: deferred?.status,
      scheduledFor: deferred?.scheduled_for,
      expectedUtc,
    },
  );

  const voidRes = await req('POST', `/invoices/${inv1?.id}/void`, {
    reason: 'connect acceptance',
  });
  const afterVoid = await msgById(remind?.id);
  ok(
    '5b void cancels the queued reminder',
    voidRes.status < 400 &&
      afterVoid?.status === 'cancelled' &&
      afterVoid?.last_error === 'invoice_void',
    afterVoid?.status,
  );
  ok(
    '5c and queues the cancellation for the customer who had it',
    (await msgs('invoice', inv1?.id, 'invoice_cancelled')).length === 1,
  );
  const invNeverSent = await makeInvoice(
    custNoConsent.id,
    'NeverSent',
    day(10),
  );
  await req('POST', `/invoices/${invNeverSent?.id}/void`, {
    reason: 'connect acceptance',
  });
  ok(
    '5d no cancellation for an invoice the customer never received',
    (await msgs('invoice', invNeverSent?.id, 'invoice_cancelled')).length === 0,
  );

  console.log('\n— 8. approval alerts and dunning');
  const alertAsk = data(
    await req('POST', '/purchase-orders', poBody, ST),
  ) as any;
  const alert = (await msgs('approval_request', alertAsk?.requestId))[0];
  const alertSent = alert ? await waitStatus(alert.id, SENT, 20_000) : null;
  ok(
    '8b approval alerts ignore quiet hours',
    !!alertSent && SENT.includes(alertSent.status) && !alertSent.scheduled_for,
    alertSent?.status,
  );
  await req('POST', `/approvals/${alertAsk?.requestId}/decide`, {
    decision: 'reject',
    comment: 'not needed',
  });

  const invUp = await makeInvoice(custA.id, 'DueIn3', day(3), 300);
  const invDue = await makeInvoice(custA.id, 'DueToday', day(0), 300);
  const invLate = await makeInvoice(custA.id, 'Late7', day(-7), 300);
  const invOff = await makeInvoice(custA.id, 'Late5', day(-5), 300);
  const dunning = app.get(DunningCronService);
  await dunning.runOnce(new Date(), COMPANY);
  const up = await msgs('invoice', invUp?.id, 'reminder_upcoming');
  const dueNow = await msgs('invoice', invDue?.id, 'reminder_overdue');
  const late = await msgs('invoice', invLate?.id, 'reminder_overdue');
  ok(
    '8c three days before the due date: one courtesy reminder (offset -3)',
    up.length === 1 && up[0].doc_version === -3,
    up.map((m) => m.doc_version),
  );
  ok(
    '8d on the due date: one reminder (offset 0)',
    dueNow.length === 1 && dueNow[0].doc_version === 0,
  );
  ok(
    '8e a week late: one overdue reminder with the invoice attached (offset 7)',
    late.length === 1 &&
      late[0].doc_version === 7 &&
      late[0].attachment?.renderer === 'invoice',
  );
  ok(
    '8f no reminder off schedule (5 days late)',
    (await msgs('invoice', invOff?.id)).filter((m) =>
      m.event_type.startsWith('reminder'),
    ).length === 0,
  );
  await dunning.runOnce(new Date(), COMPANY);
  ok(
    '8g the hourly cron queues each offset once',
    (await msgs('invoice', invLate?.id, 'reminder_overdue')).length === 1,
  );
  const paid = await req('POST', '/payments', {
    customerId: custA.id,
    paymentDate: TODAY,
    paymentMethod: 'cash',
    amount: '300',
    applications: [{ invoiceId: invLate?.id, amount: '300' }],
  });
  const lateAfter = await msgById(late[0]?.id);
  ok(
    '8h recording the payment cancels the queued reminder',
    paid.status < 400 &&
      lateAfter?.status === 'cancelled' &&
      lateAfter?.last_error === 'payment_recorded',
    lateAfter?.status,
  );
  await dunning.runOnce(new Date(), COMPANY);
  ok(
    '8i none after full payment',
    (await msgs('invoice', invLate?.id, 'reminder_overdue')).length === 1,
  );
  ok(
    '8j the payment sends a receipt',
    (await msgs('payment', data(paid)?.id, 'payment_received')).length === 1,
  );

  // Quiet hours off again: held messages are released.
  await req('PUT', '/settings/messaging', { quietHours: null });
  const released = await waitStatus(up[0]?.id, SENT, 30_000);
  ok(
    'changing quiet hours releases the messages they held',
    SENT.includes(released?.status),
    released?.status,
  );

  // ══ 7. Webhook ══════════════════════════════════════════════════
  console.log('\n— 7. the webhook');
  const hook = async (payload: unknown, signature?: string) => {
    const body = JSON.stringify(payload);
    const sig =
      signature ??
      'sha256=' + createHmac('sha256', SECRET).update(body).digest('hex');
    const r = await fetch(`${API}/webhooks/whatsapp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': sig,
      },
      body,
    });
    return r.status;
  };
  ok(
    '7a a bad signature is refused with 401',
    (await hook({ entry: [] }, 'sha256=' + '0'.repeat(64))) === 401,
  );
  ok(
    '7b a signed delivery is accepted with 200',
    (await hook({ entry: [] })) === 200,
  );
  const readRow = await msgById(issue[0]?.id);
  const evBefore = (
    await db.query(
      `SELECT count(*)::int AS n FROM message_status_events WHERE message_id = $1`,
      [readRow.id],
    )
  ).rows[0].n;
  await hook({
    entry: [
      {
        changes: [
          {
            value: {
              statuses: [
                {
                  id: readRow.provider_message_id,
                  status: 'delivered',
                  timestamp: String(Math.floor(Date.now() / 1000)),
                },
              ],
            },
          },
        ],
      },
    ],
  });
  const afterLate = await msgById(readRow.id);
  const evAfter = (
    await db.query(
      `SELECT count(*)::int AS n FROM message_status_events WHERE message_id = $1`,
      [readRow.id],
    )
  ).rows[0].n;
  ok(
    '7c a late "delivered" never moves a read message back',
    afterLate.status === 'read',
    afterLate.status,
  );
  ok('7d but the event is kept in the history', evAfter === evBefore + 1, {
    evBefore,
    evAfter,
  });
  const stopPhone = `92302${tail}`;
  const inbound = (text: string) => ({
    entry: [
      {
        changes: [
          {
            value: {
              messages: [
                { from: stopPhone, type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  });
  await hook(inbound('Stop'));
  const optedOut = (
    await db.query(`SELECT whatsapp_opt_out FROM customers WHERE id = $1`, [
      custStop.id,
    ])
  ).rows[0];
  ok('7e STOP opts the number out', optedOut?.whatsapp_opt_out === true);
  await hook(inbound('START'));
  ok(
    '7f START opts it back in',
    (
      await db.query(`SELECT whatsapp_opt_out FROM customers WHERE id = $1`, [
        custStop.id,
      ])
    ).rows[0]?.whatsapp_opt_out === false,
  );
  await hook(inbound('UNSUBSCRIBE'));

  // ══ 6. Skip reasons ═════════════════════════════════════════════
  console.log('\n— 6. why a message was not sent');
  const skipOf = async (docType: string, docId: string, event: string) =>
    (await msgs(docType, docId, event))[0];
  const iStop = await makeInvoice(custStop.id, 'Stopped', day(10));
  const sStop = await skipOf('invoice', iStop?.id, 'invoice_issued');
  ok(
    '6a opted out → skipped (opted_out)',
    sStop?.status === 'skipped' && sStop?.last_error === 'opted_out',
    sStop?.last_error,
  );
  const iNoNum = await makeInvoice(custNoNum.id, 'NoNumber', day(10));
  const sNoNum = await skipOf('invoice', iNoNum?.id, 'invoice_issued');
  ok(
    '6b no number → skipped (no_number)',
    sNoNum?.status === 'skipped' && sNoNum?.last_error === 'no_number',
    sNoNum?.last_error,
  );
  const sNoConsent = await skipOf(
    'invoice',
    invNeverSent?.id,
    'invoice_issued',
  );
  if (consentAll) {
    console.log(
      '    (company-wide consent already confirmed in this database — no_consent cannot occur; not asserted)',
    );
  } else {
    ok(
      '6c no consent → skipped (no_consent)',
      sNoConsent?.status === 'skipped' &&
        sNoConsent?.last_error === 'no_consent',
      sNoConsent?.last_error,
    );
  }
  await req('PUT', '/settings/messaging', {
    eventRules: { payment_received: 'off' },
  });
  const adv = data(
    await req('POST', '/payments', {
      customerId: custA.id,
      paymentDate: TODAY,
      paymentMethod: 'cash',
      amount: '25',
      holdAsAdvance: true,
    }),
  ) as any;
  const sOff = await skipOf('payment', adv?.id, 'payment_received');
  ok(
    '6d rule off → skipped (rule_off)',
    sOff?.status === 'skipped' && sOff?.last_error === 'rule_off',
    sOff?.last_error,
  );
  await req('PUT', '/settings/messaging', {
    eventRules: { payment_received: 'manual' },
  });
  const adv2 = data(
    await req('POST', '/payments', {
      customerId: custA.id,
      paymentDate: TODAY,
      paymentMethod: 'cash',
      amount: '25',
      holdAsAdvance: true,
    }),
  ) as any;
  const sManual = await skipOf('payment', adv2?.id, 'payment_received');
  ok(
    '6e "ask each time" → skipped (rule_manual) until someone presses Send',
    sManual?.last_error === 'rule_manual',
    sManual?.last_error,
  );
  const pressed = data(
    await req('POST', '/messages/send', {
      docType: 'payment',
      docId: adv2?.id,
    }),
  ) as any;
  ok('6f pressing Send delivers it', pressed?.status === 'queued', pressed);
  await req('PUT', '/settings/messaging', {
    eventRules: { payment_received: 'auto' },
  });
  const small = (
    await db.query(
      `SELECT id FROM companies WHERE company_type = 'small_business' AND all_features_unlocked = false LIMIT 1`,
    )
  ).rows[0];
  if (small) {
    const r = await app.get(MessagingService).enqueue(null, {
      companyId: small.id,
      event: 'invoice_issued',
      docType: 'invoice',
      docId: '00000000-0000-4000-8000-' + RUN.slice(-12).padStart(12, '0'),
      recipient: { type: 'customer', id: custA.id },
      params: {},
    });
    ok(
      '6g a tier without the feature → skipped (feature_off)',
      r?.status === 'skipped' && r?.skipReason === 'feature_off',
      r,
    );
    await db.query(`DELETE FROM outbound_messages WHERE id = $1`, [r?.id]);
  }

  // ══ Failures, resend, manual share, stats, contact health ═══════
  console.log('\n— a number that is not on WhatsApp, resend, and the API');
  const iBad = await makeInvoice(custBad.id, 'Undeliverable', day(10));
  const badMsg = (await msgs('invoice', iBad?.id, 'invoice_issued'))[0];
  const failed = await waitStatus(badMsg?.id, ['failed'], 30_000);
  ok(
    'F1 an undeliverable number fails at once (131026)',
    failed?.status === 'failed' && failed?.attempts === 1,
    failed?.status,
  );
  const note = (
    await db.query(
      `SELECT count(*)::int AS n FROM notifications WHERE company_id = $1 AND user_id = $2 AND type = 'whatsapp_failed' AND data->>'messageId' = $3`,
      [COMPANY, OWNER_ID, badMsg?.id],
    )
  ).rows[0];
  ok('F2 the sender gets an in-app alert', note?.n === 1, note);
  const resent = data(
    await req('POST', `/messages/${badMsg?.id}/resend`),
  ) as any;
  const resentRow = resent?.id ? await msgById(resent.id) : null;
  ok(
    'F3 Resend writes a new row (resend suffix on the key)',
    !!resentRow &&
      resentRow.id !== badMsg?.id &&
      /:resend:/.test(resentRow.idempotency_key),
    resent,
  );
  const share = await req('POST', '/messages/manual-share', {
    docType: 'invoice',
    docId: invUp?.id,
    toPhone: '0300 1234567',
  });
  ok(
    'M1 a wa.me hand-off is logged (wa_link, sent, no provider)',
    share.status === 200 &&
      (await msgById(data(share)?.id))?.channel === 'wa_link',
    share.body,
  );
  const stats = data(
    await req('GET', `/messages/stats?from=${day(-1)}&to=${TODAY}`),
  ) as any;
  ok(
    'M2 stats count sent, delivered, read and failed',
    stats?.sent > 0 &&
      stats?.read > 0 &&
      stats?.failed > 0 &&
      Array.isArray(stats?.recentReminders),
    stats && { sent: stats.sent, read: stats.read, failed: stats.failed },
  );
  const health = data(await req('GET', '/messages/contact-health')) as any;
  const st = (id: string) =>
    health?.contacts?.find((c: any) => c.id === id)?.status;
  ok(
    'M3 contact health names the problems',
    st(custNoNum.id) === 'missing' &&
      st(custStop.id) === 'opted_out' &&
      st(custBad.id) === 'not_on_whatsapp',
    { noNum: st(custNoNum.id), stop: st(custStop.id), bad: st(custBad.id) },
  );
  const staffGet = await req('GET', '/settings/messaging', undefined, ST);
  const staffPut = await req(
    'PUT',
    '/settings/messaging',
    { enabled: false },
    ST,
  );
  ok(
    'M4 staff can read the settings but not change them',
    staffGet.status === 200 && staffPut.status === 403,
    [staffGet.status, staffPut.status],
  );
  const test = await req('POST', '/settings/messaging/test');
  ok(
    'M5 the owner can send themselves a test',
    test.status === 200 && ['queued', 'skipped'].includes(data(test)?.status),
    test.body,
  );

  // ══ 9. Ledger invariants ════════════════════════════════════════
  console.log('\n— 9. the ledger invariants');
  const sql = readFileSync(
    join(__dirname, '..', 'qa', 'invariants.sql'),
    'utf8',
  );
  const statements = sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/--.*$/gm, '').trim())
    .filter((s) => /^select/i.test(s) || /^with/i.test(s));
  const violations: string[] = [];
  for (const s of statements) {
    const r = await db.query(s);
    for (const row of r.rows) violations.push(String(Object.values(row)[0]));
  }
  const unexpected = violations.filter(
    (v) => !KNOWN_INVARIANTS.some((k) => v.startsWith(k + ' ')),
  );
  ok(
    `9a invariants: nothing beyond the known baseline (${KNOWN_INVARIANTS.join(', ')})`,
    unexpected.length === 0,
    violations,
  );

  // ── tidy up ─────────────────────────────────────────────────────
  await req('PUT', '/settings/messaging', {
    quietHours: { start: '21:00', end: '09:00' },
  });
  if (data(staff)?.id)
    await req('PATCH', `/settings/users/${data(staff).id}/deactivate`);
  await app.close();
  await db.end();

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail) console.log(failures.map((f) => `  - ${f}`).join('\n'));
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
