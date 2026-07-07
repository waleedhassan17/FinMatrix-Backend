/**
 * phase1.md — DELIVERY ↔ LEDGER acceptance (Goods in Transit 1250).
 *
 * End-to-end over the real HTTP surface on a fresh company. Scenarios:
 *   1. Assign  → 1250 rises, 1200 falls, NO revenue, SO created (non-posting).
 *   2. Rider paid/unpaid flag posts nothing; rider cannot approve (403).
 *   3. Approve PAID     → Cash + Sales (+Tax), COGS, 1250 → 0, invoice paid.
 *   4. Approve NOT PAID → A/R + Sales, COGS, 1250 → 0, invoice OPEN in A/R
 *      aging; later Receive Payment clears it (Stage 4, no new mechanism).
 *   5. Reject/return    → Dr 1200 / Cr 1250 reversal, stock restored, NO
 *      revenue reversed (none was posted), SO cancelled.
 *   6. Approve-twice idempotency (409, books unchanged).
 *   7. Partial delivery → delivered part invoiced + COGS, remainder restocked;
 *      1250 still nets to 0.
 *   8. Pre-paid delivery → Invoice + Payment at dispatch; approval posts COGS
 *      only.
 * After EVERY scenario: Trial Balance balances, Balance Sheet balances, and
 * 1250 nets to zero for completed deliveries. Inventory Valuation ties to
 * Balance Sheet 1200 (+ 1250 while goods are in transit).
 *
 * Run against a booted server:
 *   BASE_URL=http://localhost:3001/api/v1 \
 *   PG_URL=postgres://user:pass@localhost:5432/finmatrix_qa \
 *   node -r ts-node/register -r tsconfig-paths/register test/delivery-ledger.acceptance.ts
 */
/* eslint-disable @typescript-eslint/no-var-requires */
export {};
const { Client } = require('pg');

const BASE = process.env.BASE_URL || 'http://localhost:3001/api/v1';
const PG_URL = process.env.PG_URL as string;
const SUPER_EMAIL = process.env.SUPER_EMAIL || 'waleedhassansfd@gmail.com';
const SUPER_PASSWORD = process.env.SUPER_PASSWORD || 'Waleed@104';
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
}
const close = (a: number, b: number, tol = 0.005) => Math.abs(a - b) <= tol;

interface Res { status: number; body: any; }
async function req(method: string, path: string, opts: { token?: string; companyId?: string; json?: any } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.companyId) headers['x-company-id'] = opts.companyId;
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, { method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined });
  let body: any = null;
  try { body = await r.json(); } catch { /* empty */ }
  return { status: r.status, body };
}
const data = (r: Res) => r.body?.data ?? r.body;
async function signin(email: string, password: string): Promise<Res> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await req('POST', '/auth/signin', { json: { email, password } });
    if (r.status !== 429) return r;
    console.log('    (signin throttled — waiting 15s)');
    await new Promise(res => setTimeout(res, 15_000));
  }
  return req('POST', '/auth/signin', { json: { email, password } });
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function main() {
  if (!PG_URL) throw new Error('PG_URL is required');
  const pg = new Client({ connectionString: PG_URL });
  await pg.connect();

  console.log(`\n=== phase1.md delivery-ledger acceptance @ ${BASE} ===\n`);

  // ── Setup: fresh approved company + admin + rider ────────────────────────
  console.log('— Setup');
  const superLogin = await req('POST', '/auth/signin', { json: { email: SUPER_EMAIL, password: SUPER_PASSWORD } });
  const superToken = data(superLogin)?.tokens?.accessToken;
  check('super-admin signs in', !!superToken, superLogin.status);

  const email = `qa_dlv_${Date.now()}@qa.local`;
  const signup = await req('POST', '/auth/signup', {
    json: { email, password: 'Qa@12345', displayName: 'QA Dispatcher', phone: '+92-300-1234567', role: 'admin' },
  });
  const token0 = data(signup)?.tokens?.accessToken;
  const userId = data(signup)?.user?.id;
  const createCo = await req('POST', '/companies', { token: token0, json: { name: `QA Delivery Books ${Date.now()}`, industry: 'Retail' } });
  const cid = data(createCo)?.id;
  await req('POST', `/companies/${cid}/submit`, { token: token0, companyId: cid });
  await req('PATCH', `/admin/companies/${cid}/approve`, { token: superToken });
  await pg.query(`UPDATE users SET is_email_verified = true WHERE id = $1`, [userId]);
  await pg.query(`UPDATE companies SET subscription_plan = 'standard' WHERE id = $1`, [cid]);
  const relogin = await signin(email, 'Qa@12345');
  const T = data(relogin)?.tokens?.accessToken;
  check('admin ready', !!T && !!cid);
  const A = { token: T, companyId: cid };

  const rider = data(await req('POST', '/delivery-personnel', {
    ...A, json: { email: `qa_rider_${Date.now()}@qa.local`, password: 'Rider@123', name: 'QA Rider' },
  }));
  const riderLogin = await signin(rider?.email, 'Rider@123');
  const RT = data(riderLogin)?.tokens?.accessToken;
  check('rider ready', !!rider?.userId && !!RT);

  // ── Report helpers ───────────────────────────────────────────────────────
  const trialBalance = async () => (await req('GET', `/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31`, A)).body;
  const balanceSheet = async () => (await req('GET', `/reports/balance-sheet?asOfDate=${TODAY}`, A)).body;
  const valuation = async () => (await req('GET', `/reports/inventory-valuation`, A)).body;
  const bsLine = (bs: any, code: string): number => {
    for (const sect of ['assets', 'liabilities', 'equity']) {
      const row = (bs?.[sect] ?? []).find((x: any) => x.accountCode === code);
      if (row) return Number(row.amount);
    }
    return 0;
  };
  let step = 0;
  const assertBooksBalanced = async (label: string) => {
    step++;
    const tb = await trialBalance();
    const bs = await balanceSheet();
    check(`[${step}] ${label} — TB balanced (Dr ${tb?.totalDebits} = Cr ${tb?.totalCredits})`,
      tb?.isBalanced === true && close(Number(tb?.totalDebits), Number(tb?.totalCredits), 0.005), tb);
    check(`[${step}] ${label} — BS balanced (A = L + E)`,
      bs?.isBalanced === true && close(Number(bs?.totalAssets), Number(bs?.totalLiabilities) + Number(bs?.totalEquity), 0.01),
      { a: bs?.totalAssets, l: bs?.totalLiabilities, e: bs?.totalEquity });
    return bs;
  };
  // Physical inventory tie: valuation covers ON-HAND; goods in transit sit on
  // 1250. On-hand valuation must always equal GL 1200.
  const assertInventoryTies = async (label: string) => {
    const bs = await balanceSheet();
    const val = await valuation();
    check(`${label} — BS Inventory (1200) = Valuation total (on-hand)`,
      close(bsLine(bs, '1200'), Number(val?.totalValue), 0.01),
      { gl1200: bsLine(bs, '1200'), valuation: val?.totalValue });
  };

  // ── Masters: customer + item stocked 20 @ cost 100 via PO receipt ───────
  const customer = data(await req('POST', '/customers', { ...A, json: { name: 'Delivery Customer' } }));
  const vendor = data(await req('POST', '/vendors', { ...A, json: { companyName: 'Delivery Vendor' } }));
  const item = data(await req('POST', '/inventory/items', { ...A, json: { sku: `DLV-${Date.now()}`, name: 'Crate', unitCost: '0', sellingPrice: '150' } }));
  const itemId = item?.id ?? item?.item?.id;
  check('masters created', !!customer?.id && !!vendor?.id && !!itemId);
  const po = data(await req('POST', '/purchase-orders', {
    ...A, json: { vendorId: vendor.id, orderDate: TODAY, lines: [{ description: 'Crates', orderedQty: '20', unitCost: '100', itemId }] },
  }));
  await req('POST', `/purchase-orders/${po.id}/receive`, { ...A, json: { lines: [{ lineId: po?.lines?.[0]?.id, receivedQty: '20' }] } });
  await req('POST', `/purchase-orders/${po.id}/create-bill`, { ...A, json: { billNumber: `B-${Date.now()}`, billDate: TODAY, dueDate: TODAY } });
  const stocked = data(await req('GET', `/inventory/items/${itemId}`, A));
  check('item stocked: 20 on hand @ avg 100', close(Number(stocked?.quantityOnHand), 20) && close(Number(stocked?.unitCost), 100), stocked);
  await assertBooksBalanced('after stocking');

  const qtyOnHand = async () => Number((data(await req('GET', `/inventory/items/${itemId}`, A)))?.quantityOnHand);

  // Helper: full rider lifecycle (statuses + bill photo) → returns requestId
  const riderDelivers = async (deliveryId: string, paidStatus: 'paid' | 'unpaid', changes: any[]) => {
    for (const st of ['picked_up', 'in_transit', 'arrived']) {
      await req('PATCH', `/deliveries/${deliveryId}/status`, { token: RT, companyId: cid, json: { status: st } });
    }
    const fd = new FormData();
    fd.append('photo', new Blob([PNG], { type: 'image/png' }), 'bill.png');
    fd.append('signedBy', 'Delivery Customer');
    fd.append('source', 'camera');
    fd.append('paidStatus', paidStatus);
    fd.append('changes', JSON.stringify(changes));
    const up = await fetch(`${BASE}/deliveries/${deliveryId}/bill-photo`, {
      method: 'POST', headers: { Authorization: `Bearer ${RT}`, 'x-company-id': cid }, body: fd as any,
    });
    const upBody: any = await up.json().catch(() => null);
    return { status: up.status, requestId: upBody?.data?.requestId as string | undefined, body: upBody };
  };
  const mkDelivery = async (qty: number, extra: Record<string, unknown> = {}) =>
    data(await req('POST', '/deliveries', {
      ...A,
      json: {
        customerId: customer.id, customerName: 'Delivery Customer', personnelId: rider.userId,
        items: [{ itemId, itemName: 'Crate', orderedQty: qty, unitPrice: 150, taxRate: 10 }],
        ...extra,
      },
    }));

  // ═════ Scenario 1+2+3: PAID delivery, full cycle ═════
  console.log('\n— Scenario A: assign → rider PAID → approve');
  let bs0 = await balanceSheet();
  const cashBefore = bsLine(bs0, '1000');
  const invBefore = bsLine(bs0, '1200');
  const d1 = await mkDelivery(4);
  check('S1 delivery assigned; ledger echo present', !!d1?.id && d1?.ledger?.committed === true, d1?.ledger);
  check('S1 sales order created (non-posting)', !!d1?.ledger?.salesOrderNumber, d1?.ledger);
  let bs = await assertBooksBalanced('S1 after assign');
  check('S1 Goods in Transit = 400 (4 × 100)', close(bsLine(bs, '1250'), 400, 0.01), bsLine(bs, '1250'));
  check('S1 Inventory fell 400', close(invBefore - bsLine(bs, '1200'), 400, 0.01), { invBefore, now: bsLine(bs, '1200') });
  const plAssign = (await req('GET', `/reports/profit-loss?startDate=1970-01-01&endDate=2999-12-31`, A)).body;
  const revenueAtAssign = Number(plAssign?.revenue ?? 0);
  check('S1 NO revenue at assignment', close(revenueAtAssign, 0, 0.005), revenueAtAssign);
  check('S1 on-hand fell to 16', close(await qtyOnHand(), 16), await qtyOnHand());
  await assertInventoryTies('S1 after assign');

  const pod1 = await riderDelivers(d1.id, 'paid', [{ itemId, itemName: 'Crate', beforeQty: 16, deliveredQty: 4, returnedQty: 0 }]);
  check('S2 rider POD submitted with PAID flag', pod1.status === 201 && !!pod1.requestId, pod1.body);
  bs = await assertBooksBalanced('S2 after rider flag (no posting)');
  check('S2 rider flag posted NOTHING (1250 still 400, cash unchanged)',
    close(bsLine(bs, '1250'), 400, 0.01) && close(bsLine(bs, '1000'), cashBefore, 0.01),
    { git: bsLine(bs, '1250'), cash: bsLine(bs, '1000') });

  // Rider must NOT be able to approve (server-enforced 403)
  const riderApprove = await req('POST', `/inventory-update-requests/${pod1.requestId}/approve`, { token: RT, companyId: cid, json: {} });
  check('S2 rider cannot approve (403)', riderApprove.status === 403, riderApprove.status);
  const riderReject = await req('POST', `/inventory-update-requests/${pod1.requestId}/reject`, { token: RT, companyId: cid, json: { reviewerComment: 'rider tries' } });
  check('S2 rider cannot reject (403)', riderReject.status === 403, riderReject.status);

  const approve1 = await req('POST', `/inventory-update-requests/${pod1.requestId}/approve`, { ...A, json: {} });
  check('S3 admin approval succeeded', approve1.status === 200 || approve1.status === 201, approve1.body);
  const ledger1 = data(approve1)?.ledger;
  check('S3 approval returned invoice + payment (PAID)', !!ledger1?.invoiceId && !!ledger1?.paymentId, ledger1);
  bs = await assertBooksBalanced('S3 after PAID approval');
  // 4 × 150 = 600 + 10% tax 60 → cash 660; sales +600; tax payable +60; COGS 400; GIT → 0
  check('S3 Cash rose by invoice total 660', close(bsLine(bs, '1000') - cashBefore, 660, 0.01), { before: cashBefore, after: bsLine(bs, '1000') });
  check('S3 Sales Tax Payable +60', close(bsLine(bs, '2300'), 60, 0.01), bsLine(bs, '2300'));
  check('S3 Goods in Transit nets to ZERO', close(bsLine(bs, '1250'), 0, 0.005), bsLine(bs, '1250'));
  check('S3 A/R stayed 0 (paid on the doorstep)', close(bsLine(bs, '1100'), 0, 0.005), bsLine(bs, '1100'));
  const pl1 = (await req('GET', `/reports/profit-loss?startDate=1970-01-01&endDate=2999-12-31`, A)).body;
  check('S3 P&L: revenue 600, COGS 400', close(Number(pl1?.revenue ?? 0), 600, 0.01) && close(Number(pl1?.cogs ?? 0), 400, 0.01), pl1);
  await assertInventoryTies('S3 after PAID approval');

  // Idempotency: approving the same request twice must not double-post
  const approveAgain = await req('POST', `/inventory-update-requests/${pod1.requestId}/approve`, { ...A, json: {} });
  check('S3 approve-twice rejected (409)', approveAgain.status === 409, approveAgain.status);
  bs = await balanceSheet();
  check('S3 double-approve did not double-post (cash unchanged)', close(bsLine(bs, '1000') - cashBefore, 660, 0.01), bsLine(bs, '1000'));

  // ═════ Scenario 4: NOT PAID delivery → open invoice → payment clears ═════
  console.log('\n— Scenario B: assign → rider NOT PAID → approve → A/R → payment');
  const d2 = await mkDelivery(3);
  const pod2 = await riderDelivers(d2.id, 'unpaid', [{ itemId, itemName: 'Crate', beforeQty: 13, deliveredQty: 3, returnedQty: 0 }]);
  check('S4 POD submitted (unpaid)', pod2.status === 201 && !!pod2.requestId, pod2.body);
  const approve2 = await req('POST', `/inventory-update-requests/${pod2.requestId}/approve`, { ...A, json: {} });
  check('S4 approval succeeded', approve2.status === 200 || approve2.status === 201, approve2.body);
  const ledger2 = data(approve2)?.ledger;
  check('S4 approval invoiced on credit (no payment)', !!ledger2?.invoiceId && !ledger2?.paymentId, ledger2);
  bs = await assertBooksBalanced('S4 after NOT PAID approval');
  // 3 × 150 = 450 + 45 tax = 495 open in A/R
  check('S4 A/R carries the open invoice (495)', close(bsLine(bs, '1100'), 495, 0.01), bsLine(bs, '1100'));
  check('S4 Goods in Transit nets to ZERO', close(bsLine(bs, '1250'), 0, 0.005), bsLine(bs, '1250'));
  const aging = (await req('GET', '/reports/ar-aging', A)).body;
  const agingTotal = (aging?.rows ?? aging ?? []).reduce?.((a: number, x: any) => a + Number(x.total ?? 0), 0) ?? 0;
  check('S4 open invoice appears in A/R aging (495)', close(agingTotal, 495, 0.01), agingTotal);

  // Stage 4: the EXISTING Receive Payment clears it — no new mechanism.
  const payRes = await req('POST', '/payments', {
    ...A, json: { customerId: customer.id, paymentDate: TODAY, paymentMethod: 'cash', amount: '495.00', applications: [{ invoiceId: ledger2.invoiceId, amount: '495.00' }] },
  });
  check('S4 later payment accepted', payRes.status === 200 || payRes.status === 201, payRes.body);
  bs = await assertBooksBalanced('S4 after payment');
  check('S4 A/R cleared to 0', close(bsLine(bs, '1100'), 0, 0.005), bsLine(bs, '1100'));
  await assertInventoryTies('S4 settled');

  // ═════ Scenario 5: reject/return → reversal, stock restored, no revenue ═════
  console.log('\n— Scenario C: assign → reject → reversal + restock');
  const onHandBeforeReject = await qtyOnHand();
  const revenueBeforeReject = Number(((await req('GET', `/reports/profit-loss?startDate=1970-01-01&endDate=2999-12-31`, A)).body)?.revenue ?? 0);
  const d3 = await mkDelivery(5);
  bs = await balanceSheet();
  check('S5 dispatch parked 500 in Goods in Transit', close(bsLine(bs, '1250'), 500, 0.01), bsLine(bs, '1250'));
  const pod3 = await riderDelivers(d3.id, 'unpaid', [{ itemId, itemName: 'Crate', beforeQty: 10, deliveredQty: 5, returnedQty: 0 }]);
  check('S5 POD submitted', pod3.status === 201 && !!pod3.requestId, pod3.body);
  const reject3 = await req('POST', `/inventory-update-requests/${pod3.requestId}/reject`, { ...A, json: { reviewerComment: 'Customer refused the goods' } });
  check('S5 rejection succeeded', reject3.status === 200 || reject3.status === 201, reject3.body);
  bs = await assertBooksBalanced('S5 after reject');
  check('S5 Goods in Transit reversed to ZERO', close(bsLine(bs, '1250'), 0, 0.005), bsLine(bs, '1250'));
  check('S5 stock restored to pre-dispatch on-hand', close(await qtyOnHand(), onHandBeforeReject), { before: onHandBeforeReject, after: await qtyOnHand() });
  const revenueAfterReject = Number(((await req('GET', `/reports/profit-loss?startDate=1970-01-01&endDate=2999-12-31`, A)).body)?.revenue ?? 0);
  check('S5 NO revenue posted or reversed on reject', close(revenueAfterReject, revenueBeforeReject, 0.005), { before: revenueBeforeReject, after: revenueAfterReject });
  const soCancelled = await pg.query(`SELECT status FROM sales_orders WHERE id = (SELECT sales_order_id FROM deliveries WHERE id = $1)`, [d3.id]);
  check('S5 sales order cancelled', soCancelled.rows[0]?.status === 'cancelled', soCancelled.rows[0]);
  await assertInventoryTies('S5 after reject');

  // ═════ Scenario 6: partial delivery (2 of 4) ═════
  console.log('\n— Scenario D: partial delivery — delivered part sold, rest restocked');
  const onHandBeforePartial = await qtyOnHand();
  const arBeforePartial = bsLine(await balanceSheet(), '1100');
  const d4 = await mkDelivery(4);
  const pod4 = await riderDelivers(d4.id, 'unpaid', [{ itemId, itemName: 'Crate', beforeQty: onHandBeforePartial - 4, deliveredQty: 2, returnedQty: 2 }]);
  check('S6 POD submitted (2 delivered / 2 returned)', pod4.status === 201 && !!pod4.requestId, pod4.body);
  const approve4 = await req('POST', `/inventory-update-requests/${pod4.requestId}/approve`, { ...A, json: {} });
  check('S6 approval succeeded', approve4.status === 200 || approve4.status === 201, approve4.body);
  bs = await assertBooksBalanced('S6 after partial approval');
  check('S6 Goods in Transit nets to ZERO', close(bsLine(bs, '1250'), 0, 0.005), bsLine(bs, '1250'));
  // invoice only the delivered 2 × 150 + 10% = 330
  check('S6 A/R rose by delivered value only (330)', close(bsLine(bs, '1100') - arBeforePartial, 330, 0.01), { before: arBeforePartial, after: bsLine(bs, '1100') });
  check('S6 undelivered 2 restocked (on-hand −2 net)', close(await qtyOnHand(), onHandBeforePartial - 2), { before: onHandBeforePartial, after: await qtyOnHand() });
  await assertInventoryTies('S6 after partial approval');

  // ═════ Scenario 7: pre-paid delivery ═════
  console.log('\n— Scenario E: pre-paid — Invoice + Payment at dispatch, COGS at approval');
  const cashBeforePrepaid = bsLine(await balanceSheet(), '1000');
  const d5 = await mkDelivery(2, { prePaid: true });
  check('S7 prepaid dispatch created invoice immediately', !!d5?.ledger?.invoiceNumber, d5?.ledger);
  bs = await assertBooksBalanced('S7 after prepaid dispatch');
  // 2 × 150 + 10% = 330 collected up-front
  check('S7 cash collected at dispatch (330)', close(bsLine(bs, '1000') - cashBeforePrepaid, 330, 0.01), { before: cashBeforePrepaid, after: bsLine(bs, '1000') });
  check('S7 Goods in Transit = 200', close(bsLine(bs, '1250'), 200, 0.01), bsLine(bs, '1250'));
  const pod5 = await riderDelivers(d5.id, 'paid', [{ itemId, itemName: 'Crate', beforeQty: await qtyOnHand(), deliveredQty: 2, returnedQty: 0 }]);
  const approve5 = await req('POST', `/inventory-update-requests/${pod5.requestId}/approve`, { ...A, json: {} });
  check('S7 approval succeeded', approve5.status === 200 || approve5.status === 201, approve5.body);
  bs = await assertBooksBalanced('S7 after prepaid approval');
  check('S7 approval posted COGS only — cash unchanged since dispatch', close(bsLine(bs, '1000') - cashBeforePrepaid, 330, 0.01), bsLine(bs, '1000'));
  check('S7 Goods in Transit nets to ZERO', close(bsLine(bs, '1250'), 0, 0.005), bsLine(bs, '1250'));
  await assertInventoryTies('S7 after prepaid approval');

  // ═════ Guard: insufficient stock cannot be dispatched ═════
  console.log('\n— Guard: dispatch beyond on-hand is rejected atomically');
  const hugeRes = await req('POST', '/deliveries', {
    ...A,
    json: {
      customerId: customer.id, customerName: 'Delivery Customer', personnelId: rider.userId,
      items: [{ itemId, itemName: 'Crate', orderedQty: 9999, unitPrice: 150 }],
    },
  });
  check('dispatching 9999 rejected (422)', hugeRes.status === 422, hugeRes.status);
  await assertBooksBalanced('after rejected over-dispatch (nothing half-posted)');

  // ═════ Final invariants ═════
  console.log('\n— Final invariants');
  const tbFinal = await trialBalance();
  check('FINAL: Trial Balance off by exactly 0', close(Number(tbFinal?.totalDebits), Number(tbFinal?.totalCredits), 0.005), { dr: tbFinal?.totalDebits, cr: tbFinal?.totalCredits });
  const bsFinal = await balanceSheet();
  check('FINAL: Goods in Transit 1250 nets to ZERO across all completed deliveries', close(bsLine(bsFinal, '1250'), 0, 0.005), bsLine(bsFinal, '1250'));
  await assertInventoryTies('FINAL');
  const gitRows = await pg.query(
    `SELECT COALESCE(SUM(gl.debit::numeric - gl.credit::numeric), 0) AS s
       FROM general_ledger gl JOIN accounts a ON a.id = gl.account_id
      WHERE gl.company_id = $1 AND a.account_number = '1250'`, [cid]);
  check('FINAL: GL 1250 debits = credits over the run', close(Number(gitRows.rows[0].s), 0, 0.005), gitRows.rows[0]);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fails.length) { console.log('Failed:'); fails.forEach(f => console.log(`  - ${f}`)); }
  await pg.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
