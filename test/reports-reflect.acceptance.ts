/**
 * FinMatrix — "does it actually SHOW UP?" acceptance.
 * ===================================================
 * Every other accounting suite proves the ledger is right. This one proves the
 * ledger is VISIBLE: that a document a user posts reaches the General Ledger
 * and the financial statements, on the same books, within the same request.
 *
 * That gap is the one the field report was about — "I delivered stock and
 * nothing showed up in Reports" — and none of the existing suites would have
 * caught it, because they assert on journal_entry_lines directly rather than
 * on what the report endpoints return.
 *
 *   A. An invoice posted as `sent` appears in GET /ledger, in the P&L and in
 *      the Trial Balance — asked for WITH a date range and WITHOUT one, since
 *      a dateless report that silently returns zeroes is the failure mode.
 *   B. A draft invoice appears in NONE of them, and posting it then does.
 *   C. The full delivery flow: create -> assign -> deliver -> APPROVE moves
 *      revenue and COGS into the P&L. Dispatch alone must move NEITHER —
 *      revenue is recognised when control transfers, not when the van leaves.
 *   D. An all-unpriced delivery is refused at approval with
 *      DELIVERY_ITEM_NO_PRICE, not with the posting engine's line-shape error.
 *   E. A zero-total invoice is refused with INVOICE_ZERO_TOTAL.
 *
 * Every assertion is a DELTA across the step, so the suite holds on books that
 * already contain data.
 *
 * Usage: boot the API, then
 *   API_BASE=http://localhost:3000/api/v1 \
 *   DATABASE_URL=postgres://... \
 *   npx ts-node -r tsconfig-paths/register test/reports-reflect.acceptance.ts
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';
const TODAY = new Date().toISOString().slice(0, 10);
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
let RIDER_TOKEN = '';
let RIDER_ID = '';

async function req(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = token ?? TOKEN;
  if (auth) headers.Authorization = `Bearer ${auth}`;
  if (COMPANY) headers['x-company-id'] = COMPANY;
  // Same throttle back-off the other accounting suites use: a 429 is rate
  // limiting, not a broken ledger, and running these back to back trips it.
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
/** The server's machine-readable rejection code, wherever Nest put it. */
const codeOf = (r: { body: any }) => r.body?.error?.code ?? r.body?.code;

async function main() {
  if (!DB) throw new Error('DATABASE_URL is required');
  const db = new Client({ connectionString: DB });
  await db.connect();

  console.log(`\nFinMatrix — postings reach the reports → ${API}\n`);

  const login = await req('POST', '/auth/signin', { email: EMAIL, password: PASSWORD });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  ok('admin signs in', !!TOKEN && !!COMPANY, login.status);
  if (!TOKEN) throw new Error('cannot sign in');

  // Start from open books whatever a previous suite left behind.
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  // ── Report readers ─────────────────────────────────────────────
  const DATED = `startDate=1970-01-01&endDate=2999-12-31`;

  const pnl = async (dated = true) =>
    data(await req('GET', `/reports/profit-loss${dated ? `?${DATED}` : ''}`)) as any;
  const trialBalance = async (dated = true) =>
    data(await req('GET', `/reports/trial-balance${dated ? `?${DATED}` : ''}`)) as any;
  const ledgerCount = async () => {
    const led = data(await req('GET', `/ledger?${DATED}&limit=1000`)) as any;
    const entries = led?.entries ?? led?.data ?? led ?? [];
    return Array.isArray(entries) ? entries.length : 0;
  };
  /** Net movement on one account number, straight from the GL. */
  const glNet = async (account: string) => {
    const { rows } = await db.query(
      `SELECT COALESCE(ROUND(SUM(g.debit - g.credit)::numeric, 2), 0) AS v
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id = $1 AND a.account_number = $2`,
      [COMPANY, account],
    );
    return n(rows[0]?.v);
  };

  // ── Masters ────────────────────────────────────────────────────
  const customer = data(
    await req('POST', '/customers', {
      name: `Reports Customer ${RUN}`,
      email: `reports.${RUN}@example.test`,
    }),
  );
  const vendor = data(
    await req('POST', '/vendors', { companyName: `Reports Vendor ${RUN}` }),
  );
  const priced = data(
    await req('POST', '/inventory/items', {
      sku: `RPT-P-${RUN}`,
      name: `Reports Widget ${RUN}`,
      unitOfMeasure: 'unit',
      costMethod: 'average',
      unitCost: '0',
      sellingPrice: '400',
    }),
  );
  const pricedId = priced?.id ?? priced?.item?.id;
  // Deliberately priced at zero — this is the item that must be REFUSED at
  // approval, and it goes through the ordinary API precisely because the API
  // still allows it (a free sample beside a paid line is legitimate).
  //
  // Reused across runs like the rider is. A new zero-priced item every run
  // accumulates in qa/diagnose-company.sql §6, which exists to surface exactly
  // this condition — filling it with test fixtures would blind the check.
  const { rows: existingUnpriced } = await db.query(
    `SELECT id, name FROM inventory_items
      WHERE company_id = $1 AND sku LIKE 'RPT-U-%' AND selling_price::numeric = 0
      ORDER BY created_at LIMIT 1`,
    [COMPANY],
  );
  let unpricedId: string = existingUnpriced[0]?.id ?? '';
  let unpricedName: string = existingUnpriced[0]?.name ?? '';
  if (!unpricedId) {
    unpricedName = `Unpriced Widget ${RUN}`;
    const unpriced = data(
      await req('POST', '/inventory/items', {
        sku: `RPT-U-${RUN}`,
        name: unpricedName,
        unitOfMeasure: 'unit',
        costMethod: 'average',
        unitCost: '0',
        sellingPrice: '0',
      }),
    );
    unpricedId = unpriced?.id ?? unpriced?.item?.id;
  }
  ok('masters created', !!customer?.id && !!vendor?.id && !!pricedId && !!unpricedId);

  // Stock both through a real purchase cycle so weighted-average cost is set
  // the way production sets it.
  const stock = async (itemId: string, qty: number, cost: number) => {
    const po = data(
      await req('POST', '/purchase-orders', {
        vendorId: vendor.id,
        orderDate: TODAY,
        lines: [{ description: 'stocking', orderedQty: String(qty), unitCost: String(cost), itemId }],
      }),
    );
    await req('POST', `/purchase-orders/${po.id}/receive`, {
      lines: (po.lines || []).map((l: any) => ({ lineId: l.id, receivedQty: String(qty) })),
    });
    await req('POST', `/purchase-orders/${po.id}/create-bill`, {
      billNumber: `RPT-${RUN}-${itemId.slice(0, 6)}`,
      billDate: TODAY,
      dueDate: TODAY,
    });
  };
  await stock(pricedId, 40, 250);
  await stock(unpricedId, 10, 90);

  // ═══════════════════════════════════════════════════════════════
  // A. A posted invoice reaches the ledger AND the statements
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— A. an invoice posted as `sent` shows up everywhere');

  const beforeLedger = await ledgerCount();
  const beforePnl = await pnl();
  const beforeRevenue = n(beforePnl?.revenue);

  const sentInvoice = await req('POST', '/invoices', {
    customerId: customer.id,
    invoiceDate: TODAY,
    dueDate: TODAY,
    status: 'sent',
    lines: [{ description: 'Reported sale', quantity: '2', unitPrice: '400', taxRate: '0' }],
  });
  const inv = data(sentInvoice);
  ok('A1 invoice created as sent', sentInvoice.status < 400 && !!inv?.id, sentInvoice.body);
  ok('A2 it carries a journal entry', !!inv?.journalEntryId, {
    journalEntryId: inv?.journalEntryId,
  });

  ok('A3 GET /ledger has more entries than before', (await ledgerCount()) > beforeLedger, {
    before: beforeLedger,
    after: await ledgerCount(),
  });

  const afterPnl = await pnl();
  ok(
    'A4 P&L revenue rises by exactly the invoice net',
    near(n(afterPnl?.revenue) - beforeRevenue, 800),
    { before: beforeRevenue, after: afterPnl?.revenue },
  );

  const tbDated = await trialBalance(true);
  ok('A5 trial balance balances', tbDated?.isBalanced === true, {
    dr: tbDated?.totalDebits,
    cr: tbDated?.totalCredits,
  });

  // The dateless call is the whole point of this block: a report asked for
  // without a range must return the SAME books, never a statement of zeroes.
  const pnlUndated = await pnl(false);
  const tbUndated = await trialBalance(false);
  ok(
    'A6 a DATELESS P&L returns the same revenue as the dated one',
    near(n(pnlUndated?.revenue), n(afterPnl?.revenue)),
    { dated: afterPnl?.revenue, undated: pnlUndated?.revenue },
  );
  ok(
    'A7 a DATELESS trial balance is non-empty and balances',
    Array.isArray(tbUndated?.rows) &&
      tbUndated.rows.length > 0 &&
      tbUndated?.isBalanced === true,
    { rows: tbUndated?.rows?.length, balanced: tbUndated?.isBalanced },
  );

  // ═══════════════════════════════════════════════════════════════
  // B. A draft is absent until it is posted
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— B. a draft is correctly invisible, and posting it makes it visible');

  const revenueBeforeDraft = n((await pnl())?.revenue);
  const draftRes = await req('POST', '/invoices', {
    customerId: customer.id,
    invoiceDate: TODAY,
    dueDate: TODAY,
    status: 'draft',
    lines: [{ description: 'Drafted sale', quantity: '1', unitPrice: '400', taxRate: '0' }],
  });
  const draft = data(draftRes);
  ok('B1 draft created', draftRes.status < 400 && !!draft?.id, draftRes.body);
  ok('B2 a draft posts NO journal entry', !draft?.journalEntryId, {
    journalEntryId: draft?.journalEntryId,
  });
  ok(
    'B3 the P&L does not move for a draft',
    near(n((await pnl())?.revenue), revenueBeforeDraft),
    { before: revenueBeforeDraft, after: (await pnl())?.revenue },
  );

  const sendRes = await req('POST', `/invoices/${draft.id}/send`);
  ok('B4 posting the draft succeeds', sendRes.status < 400, sendRes.body);
  ok(
    'B5 the P&L now includes it',
    near(n((await pnl())?.revenue) - revenueBeforeDraft, 400),
    { before: revenueBeforeDraft, after: (await pnl())?.revenue },
  );
  const { rows: jeRows } = await db.query(
    `SELECT journal_entry_id FROM invoices WHERE id = $1`,
    [draft.id],
  );
  ok('B6 and it now carries a journal entry', !!jeRows[0]?.journal_entry_id);

  // ═══════════════════════════════════════════════════════════════
  // C. The delivery flow: dispatch posts no sale, approval does
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— C. delivery: dispatch moves stock only, approval recognises the sale');

  // Reuse this suite's own rider if a previous run already made one.
  //
  // Delivery personnel are capped by the subscription plan, so creating a fresh
  // rider every run exhausts the allowance after two or three passes and the
  // suite then fails with DELIVERY_PERSONNEL_LIMIT_REACHED — a licensing limit
  // reported as a broken ledger. A gate has to be runnable repeatedly.
  //
  // Riders sign in with a USERNAME, never an email: '@' is what AuthService
  // uses to tell the two apart, so the rider DTO rejects one. /auth/signin's
  // `email` field is deliberately not @IsEmail and takes either, which is why
  // the username goes in it below.
  const RIDER_PASSWORD = 'Rider@123';
  const { rows: existing } = await db.query(
    `SELECT username FROM users
      WHERE role = 'delivery' AND username LIKE 'rpt.rider.%'
        AND default_company_id = $1
      ORDER BY created_at LIMIT 1`,
    [COMPANY],
  );

  let riderUsername: string = existing[0]?.username ?? '';
  let createStatus = 0;
  let createBody: unknown = null;
  if (!riderUsername) {
    riderUsername = `rpt.rider.${RUN}`;
    const riderRes = await req('POST', '/delivery-personnel', {
      username: riderUsername,
      password: RIDER_PASSWORD,
      name: `Reports Rider ${RUN}`,
      email: `rpt_rider_${RUN}@qa.local`,
    });
    createStatus = riderRes.status;
    createBody = riderRes.body;
  }

  const riderLogin = await req('POST', '/auth/signin', {
    email: riderUsername,
    password: RIDER_PASSWORD,
  });
  RIDER_TOKEN = data(riderLogin)?.tokens?.accessToken ?? '';
  RIDER_ID = data(riderLogin)?.user?.id ?? '';
  ok('C0 rider ready', !!RIDER_ID && !!RIDER_TOKEN, {
    reused: !!existing[0],
    username: riderUsername,
    create: createStatus,
    createBody,
    login: riderLogin.status,
  });

  /** create -> assign -> in_transit -> delivered -> rider submits the bill. */
  const runDelivery = async (itemId: string, itemName: string, qty: number, price: number) => {
    const created = data(
      await req('POST', '/deliveries', {
        customerId: customer.id,
        customerName: `Reports Customer ${RUN}`,
        preferredDate: TODAY,
        items: [{ itemId, itemName, orderedQty: qty, unitPrice: price }],
      }),
    );
    const deliveryId = created?.id ?? created?.delivery?.id;
    await req('POST', '/deliveries/assign', {
      deliveryIds: [deliveryId],
      personnelId: RIDER_ID,
    });
    await req('PATCH', `/deliveries/${deliveryId}/status`, { status: 'in_transit' });
    await req('PATCH', `/deliveries/${deliveryId}/status`, {
      status: 'delivered',
      paidStatus: 'unpaid',
    });

    // The rider's bill photo is multipart, so it bypasses req().
    const jpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
      'base64',
    );
    const form = new FormData();
    form.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'bill.jpg');
    form.append('signedBy', 'Reports Customer');
    form.append('source', 'camera');
    form.append('paidStatus', 'unpaid');
    form.append(
      'changes',
      JSON.stringify([{ itemId, itemName, beforeQty: 0, deliveredQty: qty, returnedQty: 0 }]),
    );
    const photoRes = await fetch(`${API}/deliveries/${deliveryId}/bill-photo`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${RIDER_TOKEN}`, 'x-company-id': COMPANY },
      body: form,
    });
    const photoBody: any = await photoRes.json().catch(() => null);
    const requestId = photoBody?.data?.requestId ?? photoBody?.data?.id;
    return { deliveryId, requestId, photoStatus: photoRes.status };
  };

  const revenueBeforeDispatch = n((await pnl())?.revenue);
  const cogsBeforeDispatch = n((await pnl())?.cogs);
  const gitBeforeDispatch = await glNet('1250');

  const qty = 3;
  const d = await runDelivery(pricedId, `Reports Widget ${RUN}`, qty, 400);
  ok('C1 rider submitted the bill photo', d.photoStatus < 400 && !!d.requestId, {
    status: d.photoStatus,
  });

  // Dispatch moved stock into Goods in Transit and NOTHING into the P&L.
  ok('C2 dispatch moved stock into Goods in Transit', (await glNet('1250')) > gitBeforeDispatch, {
    before: gitBeforeDispatch,
    after: await glNet('1250'),
  });
  const midPnl = await pnl();
  ok(
    'C3 dispatch recognised NO revenue (nothing is sold yet)',
    near(n(midPnl?.revenue), revenueBeforeDispatch),
    { before: revenueBeforeDispatch, after: midPnl?.revenue },
  );
  ok('C4 dispatch posted NO COGS', near(n(midPnl?.cogs), cogsBeforeDispatch), {
    before: cogsBeforeDispatch,
    after: midPnl?.cogs,
  });

  const approve = await req('PATCH', `/inventory-approvals/${d.requestId}/review`, {
    action: 'approved',
    notes: 'reports-reflect acceptance',
  });
  ok('C5 approval succeeds', approve.status < 400, approve.body);

  const finalPnl = await pnl();
  ok(
    'C6 approval moves revenue into the P&L',
    near(n(finalPnl?.revenue) - revenueBeforeDispatch, qty * 400),
    { before: revenueBeforeDispatch, after: finalPnl?.revenue },
  );
  ok('C7 approval moves COGS into the P&L', n(finalPnl?.cogs) > cogsBeforeDispatch, {
    before: cogsBeforeDispatch,
    after: finalPnl?.cogs,
  });
  ok(
    'C8 Goods in Transit is relieved back to where it started',
    near(await glNet('1250'), gitBeforeDispatch),
    { before: gitBeforeDispatch, after: await glNet('1250') },
  );

  const tbAfter = await trialBalance();
  ok('C9 the trial balance still balances', tbAfter?.isBalanced === true, {
    dr: tbAfter?.totalDebits,
    cr: tbAfter?.totalCredits,
  });
  const bs = data(await req('GET', `/reports/balance-sheet?asOfDate=${TODAY}`)) as any;
  ok('C10 the balance sheet still balances', bs?.isBalanced === true, {
    a: bs?.totalAssets,
    l: bs?.totalLiabilities,
    e: bs?.totalEquity,
  });

  // ═══════════════════════════════════════════════════════════════
  // D. An all-unpriced delivery is refused with a message you can act on
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— D. an unpriced delivery is refused BY NAME, not by the posting engine');

  const revenueBeforeBad = n((await pnl())?.revenue);
  const bad = await runDelivery(unpricedId, unpricedName, 2, 0);
  ok('D1 the unpriced delivery still dispatched (stock really did move)', !!bad.requestId, {
    status: bad.photoStatus,
  });

  const badApprove = await req('PATCH', `/inventory-approvals/${bad.requestId}/review`, {
    action: 'approved',
    notes: 'should be refused',
  });
  ok('D2 approval is refused', badApprove.status >= 400, badApprove.status);
  ok(
    'D3 refused with DELIVERY_ITEM_NO_PRICE, not the engine line-shape error',
    codeOf(badApprove) === 'DELIVERY_ITEM_NO_PRICE',
    { code: codeOf(badApprove), message: badApprove.body?.error?.message ?? badApprove.body?.message },
  );
  ok(
    'D4 the message names the item to fix',
    String(badApprove.body?.error?.message ?? badApprove.body?.message ?? '').includes(
      'selling price',
    ),
    badApprove.body,
  );
  ok(
    'D5 nothing was recognised as revenue by the failed approval',
    near(n((await pnl())?.revenue), revenueBeforeBad),
    { before: revenueBeforeBad, after: (await pnl())?.revenue },
  );

  // Put the stock back. A refused approval correctly leaves the delivery at
  // 'in_transit' with its goods on 1250 — that is the guard working, not a
  // leak. But every run would strand another one, and they pile up in
  // qa/diagnose-company.sql §5 as permanent noise that hides the real thing
  // that section exists to find. Rejecting exercises the reversal path anyway.
  const gitBeforeReject = await glNet('1250');
  const reject = await req('PATCH', `/inventory-approvals/${bad.requestId}/review`, {
    action: 'rejected',
    notes: 'reports-reflect acceptance — returning the unpriced stock',
  });
  ok('D6 the refused delivery can be rejected back to stock', reject.status < 400, reject.body);
  ok(
    'D7 rejecting relieves Goods in Transit',
    (await glNet('1250')) < gitBeforeReject,
    { before: gitBeforeReject, after: await glNet('1250') },
  );

  // ═══════════════════════════════════════════════════════════════
  // E. A zero-total invoice is refused before it reaches the engine
  // ═══════════════════════════════════════════════════════════════
  console.log('\n— E. a zero-total invoice is refused by name');

  const zero = await req('POST', '/invoices', {
    customerId: customer.id,
    invoiceDate: TODAY,
    dueDate: TODAY,
    status: 'sent',
    lines: [{ description: 'Free of charge', quantity: '1', unitPrice: '0', taxRate: '0' }],
  });
  ok('E1 a zero-total invoice cannot be posted', zero.status >= 400, zero.status);
  ok('E2 refused with INVOICE_ZERO_TOTAL', codeOf(zero) === 'INVOICE_ZERO_TOTAL', {
    code: codeOf(zero),
    message: zero.body?.error?.message ?? zero.body?.message,
  });

  // ── Books still sound ──────────────────────────────────────────
  const tbFinal = await trialBalance();
  ok('F1 trial balance balances at the end', tbFinal?.isBalanced === true, {
    dr: tbFinal?.totalDebits,
    cr: tbFinal?.totalCredits,
  });

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
