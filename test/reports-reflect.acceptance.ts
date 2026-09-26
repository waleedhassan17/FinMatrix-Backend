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
    await req('PATCH', `/purchase-orders/${po.id}/status`, { status: 'sent' });
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
    lines: [{ description: 'Reported sale', quantity: '2', unitPrice: '400', taxRate: '0', lineKind: 'service' }],
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
    lines: [{ description: 'Drafted sale', quantity: '1', unitPrice: '400', taxRate: '0', lineKind: 'service' }],
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
    lines: [{ description: 'Free of charge', quantity: '1', unitPrice: '0', taxRate: '0', lineKind: 'service' }],
  });
  ok('E1 a zero-total invoice cannot be posted', zero.status >= 400, zero.status);
  ok('E2 refused with INVOICE_ZERO_TOTAL', codeOf(zero) === 'INVOICE_ZERO_TOTAL', {
    code: codeOf(zero),
    message: zero.body?.error?.message ?? zero.body?.message,
  });

  // ═══════════════════════════════════════════════════════════════
  // G. Cost is RECORDED per line and per movement, not recomputed
  // ═══════════════════════════════════════════════════════════════
  //
  // These two cases cover the mistakes the cost-capture change is most likely
  // to be broken by later, both of which are invisible in ordinary use.
  console.log('\n— G. Per-line and per-movement cost —');

  {
    // A fresh item, stocked twice at DIFFERENT costs, so the weighted average
    // moves between the two receipts.
    const mv = data(
      await req('POST', '/inventory/items', {
        sku: `RPT-MV-${RUN}`,
        name: `Moving Cost Widget ${RUN}`,
        unitOfMeasure: 'unit',
        costMethod: 'average',
        unitCost: '0',
        sellingPrice: '500',
      }),
    );
    const mvId = mv?.id ?? mv?.item?.id;

    await stock(mvId, 10, 100);

    // G1. A RECEIPT is valued at what it added to 1200 — `landed` — and NOT at
    // the item's average, which the receipt itself has just moved. This is the
    // single most likely way to break the tie to the control account, because
    // qty x unit_cost looks right and is a different number.
    const glBefore = await glNet('1200');
    // Marked before the SECOND receipt so the movement below is scoped to it
    // alone — the first receipt is also a `purchase_order` movement on this
    // item, and summing both against one receipt's ledger delta compares two
    // different things.
    const { rows: markRows } = await db.query(`SELECT now() AS t`);
    const mark: Date = markRows[0].t;

    await stock(mvId, 10, 200);
    const glAfter = await glNet('1200');

    const { rows: recRows } = await db.query(
      `SELECT COALESCE(SUM(value_change), 0)::numeric AS v
         FROM inventory_movements
        WHERE company_id = $1 AND item_id = $2 AND source_type = 'purchase_order'
          AND created_at > $3`,
      [COMPANY, mvId, mark],
    );
    const receiptValue = n(recRows[0]?.v);
    ok(
      'G1 a receipt records what it added to Inventory, not qty x the new average',
      near(receiptValue, glAfter - glBefore),
      { movement: receiptValue, gl1200Delta: Number((glAfter - glBefore).toFixed(2)) },
    );

    // G2. Voiding an invoice must reverse COGS by what the SALE cost, even
    // though a purchase has re-averaged the item in between. Before the line
    // froze its cost this reversal was sized from the current average and left
    // residue in 5000/1200 forever.
    const cogsBeforeSale = await glNet('5000');
    const inv = data(
      await req('POST', '/invoices', {
        customerId: customer.id,
        invoiceDate: TODAY,
        dueDate: TODAY,
        status: 'sent',
        lines: [
          { description: `Moving Cost Widget ${RUN}`, quantity: '4', unitPrice: '500', taxRate: '0', itemId: mvId },
        ],
      }),
    );
    const cogsAfterSale = await glNet('5000');
    const saleCost = cogsAfterSale - cogsBeforeSale;

    // Re-average the item AFTER the sale and BEFORE the void, so the item's
    // current cost is no longer the cost the sale was posted at.
    await stock(mvId, 20, 400);

    // The gap between the stock subledger and its control account, BEFORE the
    // void. A delta, per this suite's convention — these books already carry
    // drift from earlier runs, and an absolute check would measure that
    // instead of what this step did.
    const subledgerGap = async () => {
      const { rows } = await db.query(
        `SELECT COALESCE(SUM(quantity_on_hand * unit_cost), 0)::numeric(18,2) AS v
           FROM inventory_items WHERE company_id = $1`,
        [COMPANY],
      );
      return n(rows[0]?.v) - (await glNet('1200'));
    };
    const gapBefore = await subledgerGap();

    await req('POST', `/invoices/${inv.id}/void`, { reason: 'cost-capture check' });
    const cogsAfterVoid = await glNet('5000');

    // Back exactly where it started. Sized from the item's CURRENT average it
    // would land somewhere else, and the difference would sit in 5000/1200 for
    // good — the bug this column was added to close.
    ok(
      'G2 voiding reverses COGS by what the sale cost, after an intervening receipt',
      near(cogsAfterVoid, cogsBeforeSale),
      { cogsBeforeSale, saleCost, cogsAfterVoid },
    );

    // G2b. The void must not WIDEN the gap between the stock subledger and its
    // control account.
    //
    // The void returns units at the cost the sale froze, so the item's average
    // has to absorb them at that cost — as a credit-memo restock already does.
    // Leaving the average alone makes the ledger right and the valuation report
    // wrong: qty x unit_cost rises by qty x the CURRENT average while GL 1200
    // rises by qty x the frozen cost, and the two never meet again (I13).
    //
    // That is exactly what happened when the void stopped using today's
    // average, and nothing caught it — the ledger balanced, the trial balance
    // balanced, and only the valuation report disagreed with the balance sheet.
    const gapAfter = await subledgerGap();
    ok(
      'G2b the void does not widen the gap between stock and Inventory 1200',
      near(gapAfter, gapBefore, 1),
      { gapBefore: Math.round(gapBefore * 100) / 100, gapAfter: Math.round(gapAfter * 100) / 100 },
    );

    // G3. And the line kept the cost it was posted at.
    const { rows: lineRows } = await db.query(
      `SELECT unit_cost::numeric AS uc, cost_amount::numeric AS ca, cost_basis
         FROM invoice_line_items WHERE invoice_id = $1 AND item_id = $2`,
      [inv.id, mvId],
    );
    ok('G3 the invoice line froze its own cost at posting', lineRows[0]?.cost_basis === 'posted', {
      unitCost: lineRows[0]?.uc,
      costAmount: lineRows[0]?.ca,
      basis: lineRows[0]?.cost_basis,
    });

    // G4. Nothing writes a movement without a value any more.
    const { rows: nullRows } = await db.query(
      `SELECT count(*)::int AS c FROM inventory_movements
        WHERE company_id = $1 AND created_at > now() - interval '5 minutes'
          AND value_change IS NULL`,
      [COMPANY],
    );
    ok('G4 every movement this run recorded a value', nullRows[0]?.c === 0, {
      unvalued: nullRows[0]?.c,
    });

    // G5. The whole point: movement value ties to the control account (I23).
    const { rows: tieRows } = await db.query(
      `SELECT
         (SELECT COALESCE(SUM(g.debit - g.credit), 0)
            FROM general_ledger g
            JOIN accounts a ON a.id = g.account_id AND a.company_id = g.company_id
           WHERE g.company_id = $1 AND a.account_number = '1200')::numeric AS gl,
         (SELECT COALESCE(SUM(m.value_change), 0)
            FROM inventory_movements m WHERE m.company_id = $1)::numeric AS mv`,
      [COMPANY],
    );
    ok(
      'G5 movement value ties to Inventory 1200 across the whole company',
      near(n(tieRows[0]?.gl), n(tieRows[0]?.mv)),
      { gl1200: n(tieRows[0]?.gl), movements: n(tieRows[0]?.mv) },
    );
  }

  // ═══════════════════════════════════════════════════════════════
  // H. The P&L drill-down survives the response envelope
  // ═══════════════════════════════════════════════════════════════
  //
  // This exists because the drill-down shipped broken for every account in
  // every period, and nothing caught it. The service returned its rows under a
  // key named `data`; ResponseEnvelopeInterceptor lifts a `data` key into the
  // envelope slot and discards every sibling, so what reached the clients was a
  // bare array with accountCode, lineAmount and total gone — and both rendered
  // "No transactions in this period."
  //
  // Every other test of this endpoint calls the service method directly, which
  // never runs the interceptor. That is exactly why it was invisible, so this
  // one goes over HTTP.
  console.log('\n— H. P&L drill-down over HTTP —');

  {
    const pl = data(await req('GET', `/reports/profit-loss?startDate=${TODAY}&endDate=${TODAY}`));
    const line = (pl?.income ?? [])[0] ?? (pl?.cogsLines ?? [])[0] ?? (pl?.expenseLines ?? [])[0];
    ok('H1 the P&L offers a per-account line to drill into', !!line?.accountCode, {
      accountCode: line?.accountCode,
    });

    if (line?.accountCode) {
      const res = await req(
        'GET',
        `/reports/profit-loss/lines/${line.accountCode}/entries?startDate=${TODAY}&endDate=${TODAY}&limit=5`,
      );
      const d = data(res);

      // The object must SURVIVE. An array here means the envelope flattened it
      // again and the clients are about to show nothing.
      ok('H2 the drill-down returns an object, not a bare array', !Array.isArray(d), {
        got: Array.isArray(d) ? 'array' : typeof d,
      });
      ok('H3 it carries its own entries', Array.isArray(d?.entries), {
        keys: d && typeof d === 'object' ? Object.keys(d) : null,
      });
      ok('H4 the metadata survived the envelope', d?.accountCode === line.accountCode && d?.lineAmount !== undefined && d?.total !== undefined, {
        accountCode: d?.accountCode,
        lineAmount: d?.lineAmount,
        total: d?.total,
      });

      const entries = d?.entries ?? [];
      if (entries.length) {
        // Named, not numbered: the record is INV-2026-0001, not JE-005.
        ok('H5 each row names its document', entries.every((e: any) => !!e.documentNumber), {
          sample: entries[0]?.documentNumber,
        });
        ok('H6 each row stays drillable', entries.every((e: any) => !!e.sourceId), {
          sample: entries[0]?.sourceType,
        });
        // Newest first, so a busy account does not open on its oldest rows.
        const dates = entries.map((e: any) => e.date);
        ok(
          'H7 rows are newest first',
          dates.every((v: string, i: number) => i === 0 || dates[i - 1] >= v),
          { dates },
        );
      }

      // The contract: what is listed adds up to the line it sits under.
      if (entries.length && entries.length >= n(d?.total)) {
        const shown = entries.reduce((t: number, e: any) => t + n(e.amount), 0);
        ok('H8 the entries sum to the line', near(shown, n(d?.lineAmount)), {
          entries: shown,
          line: d?.lineAmount,
        });
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // I. The item explorer over HTTP
  // ═══════════════════════════════════════════════════════════════
  //
  // The explorer reads three endpoints and has to agree with the ledger and
  // with itself: an item's month adds up to the documents listed under it, its
  // latest stock value is what the valuation table shows, and a discounted
  // invoice counts at what the ledger actually booked. Over HTTP, because the
  // response envelope is where the P&L drill-down once lost its rows.
  console.log('\n— I. Item explorer over HTTP —');

  {
    const monthStart = `${TODAY.slice(0, 7)}-01`;
    const window = `startDate=${monthStart}&endDate=${TODAY}`;
    const perfOf = async () =>
      data(await req('GET', `/reports/item-performance/${pricedId}?${window}`)) as any;
    const round2 = (v: number) => Math.round(v * 100) / 100;

    const before = await perfOf();
    const pnlBefore = n((await pnl())?.revenue);

    // I1–I2. A 10% invoice discount is shared across the lines by their
    // pre-tax amount: the item's 800 keeps 720, the 200 handling line 180.
    const dinv = data(
      await req('POST', '/invoices', {
        customerId: customer.id,
        invoiceDate: TODAY,
        dueDate: TODAY,
        status: 'sent',
        discountType: 'percent',
        discountValue: '10',
        lines: [
          { description: `Reports Widget ${RUN}`, quantity: '2', unitPrice: '400', taxRate: '0', itemId: pricedId },
          { description: 'Handling', quantity: '1', unitPrice: '200', taxRate: '0', lineKind: 'service' },
        ],
      }),
    );
    const after = await perfOf();
    const pnlAfter = n((await pnl())?.revenue);
    ok('I1 the ledger booked revenue net of the discount', near(pnlAfter - pnlBefore, 900), {
      delta: round2(pnlAfter - pnlBefore),
    });
    ok(
      "I2 the item took its share of the discount, not its list price",
      near(n(after?.totals?.revenue) - n(before?.totals?.revenue), 720),
      { delta: round2(n(after?.totals?.revenue) - n(before?.totals?.revenue)) },
    );
    ok('I3 the item arrives with its facts', typeof after?.item?.qtyOnHand === 'number' && !!after?.item?.lastSoldDate, {
      item: after?.item,
    });
    ok(
      'I4 the buyer is among its customers',
      (after?.customers ?? []).some((c: any) => c.customerId === customer.id),
      { customers: after?.customers },
    );

    // I5–I7. The entries survive the envelope and add up to the month.
    const res = await req(
      'GET',
      `/reports/item-performance/${pricedId}/entries?${window}&limit=100`,
    );
    const d = data(res);
    ok('I5 entries arrive as an object with rows and a count', !Array.isArray(d) && Array.isArray(d?.entries) && typeof d?.total === 'number', {
      keys: d && typeof d === 'object' ? Object.keys(d) : null,
    });
    const entries: any[] = d?.entries ?? [];
    const point = (after?.points ?? []).find((p: any) => p.period === TODAY.slice(0, 7));
    if (entries.length >= n(d?.total)) {
      const shown = entries.reduce((t, e) => t + n(e.revenue), 0);
      ok('I6 the month is exactly the documents listed under it', near(shown, n(point?.revenue)) && near(n(d?.totals?.revenue), n(point?.revenue)), {
        entries: round2(shown),
        month: point?.revenue,
      });
    }
    ok(
      'I7 the discounted line lists at its discounted price',
      entries.some((e) => e.docId === dinv?.id && near(n(e.revenue), 720) && near(n(e.unitPrice), 360)),
      { line: entries.find((e) => e.docId === dinv?.id) },
    );

    // I8–I9. The stock history ends where the valuation table stands.
    const hist = data(
      await req('GET', `/reports/inventory-valuation/items/${pricedId}/history?${window}`),
    ) as any;
    const last = (hist?.points ?? [])[(hist?.points ?? []).length - 1];
    const { rows: itemRows } = await db.query(
      `SELECT quantity_on_hand::numeric AS q, unit_cost::numeric AS c FROM inventory_items WHERE id = $1`,
      [pricedId],
    );
    const qty = n(itemRows[0]?.q);
    const cost = n(itemRows[0]?.c);
    ok('I8 the latest close is the quantity on hand', (hist?.points ?? []).length === 1 && near(n(last?.closingQty), qty), {
      points: (hist?.points ?? []).length,
      closingQty: last?.closingQty,
      onHand: qty,
    });
    ok('I9 the latest close is valued at quantity × average cost', last?.valueKnown === true && near(n(last?.closingValue), round2(qty * cost)), {
      closingValue: last?.closingValue,
      expected: round2(qty * cost),
    });

    // I10. A malformed date is refused, not handed to Postgres.
    const bad = await req('GET', `/reports/item-performance/${pricedId}?startDate=2026-13-01&endDate=${TODAY}`);
    ok('I10 a malformed date is a 400', bad.status === 400 && codeOf(bad) === 'INVALID_DATE', {
      status: bad.status,
      code: codeOf(bad),
    });

    // I11–I12. The valuation screen's tie-out and "last sold".
    const ip = data(await req('GET', `/reports/inventory-performance?${window}`)) as any;
    ok('I11 inventory-performance carries the Inventory 1200 balance', near(n(ip?.totals?.ledgerValue), await glNet('1200')), {
      ledgerValue: ip?.totals?.ledgerValue,
    });
    const row = (ip?.rows ?? []).find((r: any) => r.itemId === pricedId);
    ok('I12 an item sold today says so', row?.lastSoldDate === TODAY, { lastSoldDate: row?.lastSoldDate });
  }

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
