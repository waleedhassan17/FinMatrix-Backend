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
 *   8. Pre-paid delivery → a receipt (RCT) held in 2400 at creation, no sale
 *      at dispatch; approval invoices, applies the advance, posts COGS.
 *   9. Rider PARTIAL → cash for part, rest in A/R; a later receipt settles it.
 *  10. Part advance + rider collects the balance; the owner's cash count
 *      overrides the rider's figure.
 *  11. Prepaid, part returned → the unused advance stays on the receipt.
 *  12. A rider cannot turn a prepaid delivery unpaid, on any route.
 *  13. Owner creates an advance delivery directly; staff can only request one,
 *      and nothing exists until the owner approves it.
 *  14. PARTIAL for nothing, or for more than is due, is refused.
 *  15. An advance cannot be deleted while its delivery is on the road.
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
/** Email or username — sign-in resolves either from `identifier`. */
async function signin(identifier: string, password: string): Promise<Res> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await req('POST', '/auth/signin', { json: { identifier, password } });
    if (r.status !== 429) return r;
    console.log('    (signin throttled — waiting 15s)');
    await new Promise(res => setTimeout(res, 15_000));
  }
  return req('POST', '/auth/signin', { json: { identifier, password } });
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

  // Riders sign in with a username and a password, never an email.
  const riderUsername = `qa.rider.${Date.now()}`;
  const rider = data(await req('POST', '/delivery-personnel', {
    ...A, json: { username: riderUsername, password: 'Rider@123', name: 'QA Rider' },
  }));
  const riderLogin = await signin(riderUsername, 'Rider@123');
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
  await req('PATCH', `/purchase-orders/${po.id}/status`, { ...A, json: { status: 'sent' } });
  await req('POST', `/purchase-orders/${po.id}/receive`, { ...A, json: { lines: [{ lineId: po?.lines?.[0]?.id, receivedQty: '20' }] } });
  await req('POST', `/purchase-orders/${po.id}/create-bill`, { ...A, json: { billNumber: `B-${Date.now()}`, billDate: TODAY, dueDate: TODAY } });
  const stocked = data(await req('GET', `/inventory/items/${itemId}`, A));
  check('item stocked: 20 on hand @ avg 100', close(Number(stocked?.quantityOnHand), 20) && close(Number(stocked?.unitCost), 100), stocked);
  await assertBooksBalanced('after stocking');

  const qtyOnHand = async () => Number((data(await req('GET', `/inventory/items/${itemId}`, A)))?.quantityOnHand);
  const itemCost = async () => Number((data(await req('GET', `/inventory/items/${itemId}`, A)))?.unitCost);

  // Helper: full rider lifecycle (statuses + bill photo) → returns requestId
  const riderDelivers = async (
    deliveryId: string,
    paidStatus: 'paid' | 'partial' | 'unpaid',
    changes: any[],
    amountCollected?: string,
  ) => {
    for (const st of ['picked_up', 'in_transit', 'arrived']) {
      await req('PATCH', `/deliveries/${deliveryId}/status`, { token: RT, companyId: cid, json: { status: st } });
    }
    const fd = new FormData();
    fd.append('photo', new Blob([PNG], { type: 'image/png' }), 'bill.png');
    fd.append('signedBy', 'Delivery Customer');
    fd.append('source', 'camera');
    fd.append('paidStatus', paidStatus);
    if (amountCollected !== undefined) fd.append('amountCollected', amountCollected);
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

  // ═════ Restock for the payment scenarios, at the same cost ═════
  const po3 = data(await req('POST', '/purchase-orders', {
    ...A, json: { vendorId: vendor.id, orderDate: TODAY, lines: [{ description: 'More crates', orderedQty: '40', unitCost: '100', itemId }] },
  }));
  await req('PATCH', `/purchase-orders/${po3.id}/status`, { ...A, json: { status: 'sent' } });
  await req('POST', `/purchase-orders/${po3.id}/receive`, { ...A, json: { lines: [{ lineId: po3?.lines?.[0]?.id, receivedQty: '40' }] } });
  check('restocked 40 @ 100 (average unchanged)', close(await itemCost(), 100, 0.01), await itemCost());

  const approve = async (requestId: string | undefined, body: Record<string, unknown> = {}) => {
    const r = await req('POST', `/inventory-update-requests/${requestId}/approve`, { ...A, json: body });
    return { status: r.status, ledger: data(r)?.ledger, body: r.body };
  };
  const deliveryRow = async (id: string) => data(await req('GET', `/deliveries/${id}`, A));
  const line = (deliveredQty: number, returnedQty = 0) => [
    { itemId, itemName: 'Crate', beforeQty: 0, deliveredQty, returnedQty },
  ];
  // What the receipts ledger says the company holds for customers.
  const unappliedOnReceipts = async () => Number((await pg.query(
    `SELECT COALESCE(SUM(p.amount - COALESCE(a.applied, 0)), 0) AS s
       FROM payments p
       LEFT JOIN (SELECT payment_id, SUM(amount_applied) AS applied FROM payment_applications GROUP BY payment_id) a
         ON a.payment_id = p.id
      WHERE p.company_id = $1 AND p.advance_posted = true`, [cid])).rows[0].s);
  const assertAdvancesTie = async (label: string) => {
    const bs2400 = bsLine(await balanceSheet(), '2400');
    const receipts = await unappliedOnReceipts();
    check(`${label} — GL 2400 (${bs2400}) = unapplied on receipts (${receipts})`, close(bs2400, receipts, 0.01), { bs2400, receipts });
  };

  // ═════ Scenario 7: pre-paid delivery ═════
  // 2 × 150 + 10% = 330, paid before dispatch.
  console.log('\n— Scenario E: pre-paid — receipt held in 2400 at creation, sale at approval');
  let bsE = await balanceSheet();
  const cashBeforePrepaid = bsLine(bsE, '1000');
  const advBeforePrepaid = bsLine(bsE, '2400');
  const arBeforePrepaid = bsLine(bsE, '1100');
  const approvalsBefore = Number((await pg.query(`SELECT COUNT(*) AS n FROM approval_requests WHERE company_id = $1`, [cid])).rows[0].n);
  const d5 = await mkDelivery(2, { prePaid: true });
  check('S7 owner creates a prepaid delivery directly (no approval request)',
    !!d5?.id && !d5?.pending &&
      Number((await pg.query(`SELECT COUNT(*) AS n FROM approval_requests WHERE company_id = $1`, [cid])).rows[0].n) === approvalsBefore,
    d5);
  check('S7 advance recorded as a receipt (RCT) for 330', /^RCT-/.test(d5?.advance?.paymentNumber ?? '') && close(Number(d5?.advance?.amount), 330, 0.01), d5?.advance);
  check('S7 NO invoice at dispatch', !d5?.ledger?.invoiceNumber && !d5?.invoiceId, d5?.ledger);
  check('S7 delivery reads prepaid + PAID', d5?.prepaid === true && d5?.paidStatus === 'paid', { prepaid: d5?.prepaid, paidStatus: d5?.paidStatus });
  bs = await assertBooksBalanced('S7 after prepaid create + dispatch');
  check('S7 cash +330 and Customer Advances +330', close(bsLine(bs, '1000') - cashBeforePrepaid, 330, 0.01) && close(bsLine(bs, '2400') - advBeforePrepaid, 330, 0.01),
    { cash: bsLine(bs, '1000') - cashBeforePrepaid, adv: bsLine(bs, '2400') - advBeforePrepaid });
  check('S7 Goods in Transit = 200', close(bsLine(bs, '1250'), 200, 0.01), bsLine(bs, '1250'));
  const reserved = data(await req('GET', `/payments/customer/${customer.id}/advances`, A));
  check('S7 the advance is reserved for its delivery (not offered to other invoices)',
    !(reserved?.advances ?? []).some((a: any) => a.paymentId === d5?.advance?.paymentId), reserved);
  await assertAdvancesTie('S7 after prepaid create');

  const pod5 = await riderDelivers(d5.id, 'unpaid', line(2));
  check('S7 rider answering NOT PAID on a prepaid delivery still reads PAID, nothing due',
    pod5.status === 201 && pod5.body?.data?.paidStatus === 'paid' && close(Number(pod5.body?.data?.amountDue), 0, 0.001), pod5.body);
  const ap5 = await approve(pod5.requestId);
  check('S7 approval succeeded', ap5.status === 200 || ap5.status === 201, ap5.body);
  check('S7 approval applied the advance: PAID, 330 applied, no cash receipt, nothing in A/R',
    ap5.ledger?.paidStatus === 'paid' && close(Number(ap5.ledger?.advanceApplied), 330, 0.01) && !ap5.ledger?.paymentId &&
      close(Number(ap5.ledger?.balanceDue), 0, 0.001), ap5.ledger);
  bs = await assertBooksBalanced('S7 after prepaid approval');
  check('S7 cash unchanged since the advance; 2400 released; A/R unchanged',
    close(bsLine(bs, '1000') - cashBeforePrepaid, 330, 0.01) && close(bsLine(bs, '2400'), advBeforePrepaid, 0.01) && close(bsLine(bs, '1100'), arBeforePrepaid, 0.01),
    { cash: bsLine(bs, '1000'), adv: bsLine(bs, '2400'), ar: bsLine(bs, '1100') });
  check('S7 Goods in Transit nets to ZERO', close(bsLine(bs, '1250'), 0, 0.005), bsLine(bs, '1250'));
  const apps5 = await pg.query(`SELECT COALESCE(SUM(amount_applied), 0) AS s FROM payment_applications WHERE invoice_id = $1 AND payment_id = $2`, [ap5.ledger?.invoiceId, d5?.advance?.paymentId]);
  check('S7 the invoice shows the advance receipt in its payment history', close(Number(apps5.rows[0].s), 330, 0.01), apps5.rows[0]);
  await assertInventoryTies('S7 after prepaid approval');
  await assertAdvancesTie('S7 after prepaid approval');

  // ═════ Scenario 9: rider collects PART of a credit sale ═════
  console.log('\n— Scenario G: rider PARTIAL — cash for part, rest in A/R');
  bs = await balanceSheet();
  const cashG = bsLine(bs, '1000');
  const arG = bsLine(bs, '1100');
  const d7 = await mkDelivery(2);
  const pod7 = await riderDelivers(d7.id, 'partial', line(2), '100');
  check('S9 rider PARTIAL 100 of 330 accepted', pod7.status === 201 && pod7.body?.data?.paidStatus === 'partial' &&
    close(Number(pod7.body?.data?.amountCollected), 100, 0.001) && close(Number(pod7.body?.data?.amountDue), 330, 0.01), pod7.body);
  bs = await balanceSheet();
  check('S9 the rider answer posted NOTHING', close(bsLine(bs, '1000'), cashG, 0.01), bsLine(bs, '1000'));
  const ap7 = await approve(pod7.requestId);
  check('S9 approval: PARTIAL, 100 collected, 230 left in A/R',
    ap7.ledger?.paidStatus === 'partial' && close(Number(ap7.ledger?.amountCollected), 100, 0.01) && close(Number(ap7.ledger?.balanceDue), 230, 0.01) && !!ap7.ledger?.paymentId,
    ap7.ledger);
  bs = await assertBooksBalanced('S9 after partial approval');
  check('S9 cash +100, A/R +230', close(bsLine(bs, '1000') - cashG, 100, 0.01) && close(bsLine(bs, '1100') - arG, 230, 0.01),
    { cash: bsLine(bs, '1000') - cashG, ar: bsLine(bs, '1100') - arG });
  const inv7 = await pg.query(`SELECT status, balance FROM invoices WHERE id = $1`, [ap7.ledger?.invoiceId]);
  check('S9 invoice is partial with 230 open', inv7.rows[0]?.status === 'partial' && close(Number(inv7.rows[0]?.balance), 230, 0.01), inv7.rows[0]);
  check('S9 delivery reads PARTIAL', (await deliveryRow(d7.id))?.paidStatus === 'partial');
  await req('POST', '/payments', {
    ...A, json: { customerId: customer.id, paymentDate: TODAY, paymentMethod: 'cash', amount: '230', applications: [{ invoiceId: ap7.ledger?.invoiceId, amount: '230' }] },
  });
  check('S9 a later receipt for the rest turns the delivery PAID', (await deliveryRow(d7.id))?.paidStatus === 'paid');
  bs = await assertBooksBalanced('S9 after the rest is paid');
  check('S9 A/R back where it started', close(bsLine(bs, '1100'), arG, 0.01), bsLine(bs, '1100'));

  // ═════ Scenario 10: part advance, rider collects the balance, owner recounts ═════
  console.log('\n— Scenario H: 100 paid up front, rider collects the balance, owner counts 200');
  bs = await balanceSheet();
  const cashH = bsLine(bs, '1000');
  const arH = bsLine(bs, '1100');
  const advH = bsLine(bs, '2400');
  const d8 = await mkDelivery(2, { advanceAmount: '100' });
  check('S10 part advance: receipt of 100, not prepaid, nothing decided yet',
    close(Number(d8?.advance?.amount), 100, 0.01) && d8?.prepaid === false && !d8?.paidStatus, { advance: d8?.advance, prepaid: d8?.prepaid, paid: d8?.paidStatus });
  const pod8 = await riderDelivers(d8.id, 'paid', line(2));
  check('S10 rider PAID collects the 230 balance, not the order total',
    pod8.body?.data?.paidStatus === 'paid' && close(Number(pod8.body?.data?.amountCollected), 230, 0.01) && close(Number(pod8.body?.data?.amountDue), 230, 0.01), pod8.body);
  const tooMuch = await approve(pod8.requestId, { amountCollected: '231' });
  check('S10 owner cannot count more cash than was due (400)', tooMuch.status === 400, tooMuch.body);
  const ap8 = await approve(pod8.requestId, { amountCollected: '200' });
  check('S10 approval with owner count 200: advance 100, cash 200, 30 in A/R, PARTIAL',
    ap8.ledger?.paidStatus === 'partial' && close(Number(ap8.ledger?.advanceApplied), 100, 0.01) &&
      close(Number(ap8.ledger?.amountCollected), 200, 0.01) && close(Number(ap8.ledger?.balanceDue), 30, 0.01), ap8.ledger);
  bs = await assertBooksBalanced('S10 after approval');
  check('S10 cash +300 overall, A/R +30, 2400 back to where it started',
    close(bsLine(bs, '1000') - cashH, 300, 0.01) && close(bsLine(bs, '1100') - arH, 30, 0.01) && close(bsLine(bs, '2400'), advH, 0.01),
    { cash: bsLine(bs, '1000') - cashH, ar: bsLine(bs, '1100') - arH, adv: bsLine(bs, '2400') - advH });
  const audit8 = await pg.query(`SELECT details FROM inventory_approval_audit_entries WHERE request_id = $1 AND action = 'approved'`, [pod8.requestId]).catch(() => ({ rows: [] as any[] }));
  check('S10 the audit trail names the rider figure and the owner count',
    /Rider reported 230\.00 collected; owner counted 200\.00/.test(audit8.rows[0]?.details ?? ''), audit8.rows[0]);
  await assertAdvancesTie('S10 after approval');

  // ═════ Scenario 11: prepaid, one unit comes back ═════
  console.log('\n— Scenario I: prepaid 3, customer keeps 2 — the unused advance stays theirs');
  bs = await balanceSheet();
  const advI = bsLine(bs, '2400');
  const d9 = await mkDelivery(3, { prePaid: true }); // 495
  const pod9 = await riderDelivers(d9.id, 'paid', line(2, 1));
  check('S11 nothing to collect (the advance covers the 330 kept)', close(Number(pod9.body?.data?.amountDue), 0, 0.001), pod9.body);
  const ap9 = await approve(pod9.requestId);
  check('S11 approval applied 330 of the 495 advance, PAID',
    ap9.ledger?.paidStatus === 'paid' && close(Number(ap9.ledger?.advanceApplied), 330, 0.01), ap9.ledger);
  bs = await assertBooksBalanced('S11 after approval');
  check('S11 165 stays in Customer Advances', close(bsLine(bs, '2400') - advI, 165, 0.01), bsLine(bs, '2400') - advI);
  const free9 = data(await req('GET', `/payments/customer/${customer.id}/advances`, A));
  const left9 = (free9?.advances ?? []).find((a: any) => a.paymentId === d9?.advance?.paymentId);
  check('S11 …on the customer’s receipt, free to apply or refund', close(Number(left9?.unapplied), 165, 0.01), free9);
  await assertInventoryTies('S11 after approval');
  await assertAdvancesTie('S11 after approval');

  // ═════ Scenario 12: rider cannot unpay a prepaid delivery on the status route ═════
  console.log('\n— Scenario J: rider sends NOT PAID on the status route of a prepaid delivery');
  const d10 = await mkDelivery(1, { prePaid: true });
  await req('PATCH', `/deliveries/${d10.id}/status`, { token: RT, companyId: cid, json: { status: 'picked_up', paidStatus: 'unpaid' } });
  const statusFlip = await req('PATCH', `/deliveries/${d10.id}/status`, { token: RT, companyId: cid, json: { status: 'in_transit', paidStatus: 'partial', amountCollected: '5' } });
  check('S12 status route accepted but the delivery still reads PAID with nothing collected',
    statusFlip.status === 200 && (await deliveryRow(d10.id))?.paidStatus === 'paid' && close(Number((await deliveryRow(d10.id))?.amountCollected ?? 0), 0, 0.001),
    await deliveryRow(d10.id));
  const pod10 = await riderDelivers(d10.id, 'partial', line(1), '50');
  check('S12 bill photo PARTIAL on a prepaid delivery reads PAID', pod10.body?.data?.paidStatus === 'paid', pod10.body);
  const ap10 = await approve(pod10.requestId);
  check('S12 approval records no cash from the rider', ap10.ledger?.paidStatus === 'paid' && !ap10.ledger?.paymentId, ap10.ledger);

  // ═════ Scenario 13: owner direct vs staff request ═════
  console.log('\n— Scenario K: staff may only REQUEST an advance delivery');
  const suffix = Date.now();
  const staff = await req('POST', '/settings/users', {
    ...A, json: { name: 'QA Staff', username: `qa.staff.${suffix}`, password: 'Test1234!', role: 'staff' },
  });
  check('S13 staff user created', staff.status === 201, staff.body);
  const staffLogin = await signin(`qa.staff.${suffix}`, 'Test1234!');
  const ST = data(staffLogin)?.tokens?.accessToken;
  check('S13 staff signs in', !!ST, staffLogin.body);
  const S = { token: ST, companyId: cid };
  const counts = async () => (await pg.query(
    `SELECT (SELECT COUNT(*) FROM deliveries WHERE company_id = $1) AS d,
            (SELECT COUNT(*) FROM payments WHERE company_id = $1) AS p,
            (SELECT COUNT(*) FROM journal_entries WHERE company_id = $1) AS j`, [cid])).rows[0];
  const before13 = await counts();
  const adv13 = bsLine(await balanceSheet(), '2400');
  const staffAdvance = await req('POST', '/deliveries', {
    ...S,
    json: {
      customerId: customer.id, customerName: 'Delivery Customer', personnelId: rider.userId,
      items: [{ itemId, itemName: 'Crate', orderedQty: 1, unitPrice: 150, taxRate: 10 }],
      advanceAmount: '165',
    },
  });
  const pending13 = data(staffAdvance);
  check('S13 staff advance delivery is filed for the owner', pending13?.pending === true && !!pending13?.requestId && pending13?.type === 'delivery_advance', staffAdvance.body);
  const after13 = await counts();
  check('S13 nothing exists yet — no delivery, receipt or journal', after13.d === before13.d && after13.p === before13.p && after13.j === before13.j, { before13, after13 });
  const staffPlain = await req('POST', '/deliveries', {
    ...S, json: { customerId: customer.id, customerName: 'Delivery Customer', items: [{ itemId, itemName: 'Crate', orderedQty: 1, unitPrice: 150 }] },
  });
  check('S13 staff delivery WITHOUT an advance is still direct', !!data(staffPlain)?.id && !data(staffPlain)?.pending, staffPlain.body);
  const staffDecides = await req('POST', `/approvals/${pending13?.requestId}/decide`, { ...S, json: { decision: 'approve' } });
  check('S13 staff cannot approve it (403)', staffDecides.status === 403, staffDecides.status);
  const ownerDecides = await req('POST', `/approvals/${pending13?.requestId}/decide`, { ...A, json: { decision: 'approve' } });
  const decided = data(ownerDecides);
  check('S13 owner approves it', ownerDecides.status === 200 && decided?.status === 'approved' && !!decided?.resultId, ownerDecides.body);
  const created13 = decided?.resultId ? await deliveryRow(decided.resultId) : null;
  check('S13 the delivery now exists, prepaid, dispatched to the rider',
    created13?.prepaid === true && created13?.ledgerStatus === 'in_transit' && created13?.personnelId === rider.userId, created13);
  const memo13 = await pg.query(`SELECT memo, amount FROM payments WHERE id = $1`, [created13?.advancePaymentId]);
  check('S13 its receipt names who prepared it', /prepared by QA Staff, approved by owner/.test(memo13.rows[0]?.memo ?? '') && close(Number(memo13.rows[0]?.amount), 165, 0.01), memo13.rows[0]);
  check('S13 2400 +165', close(bsLine(await balanceSheet(), '2400') - adv13, 165, 0.01));
  await assertBooksBalanced('S13 after owner approval');
  const pod13 = await riderDelivers(created13.id, 'paid', line(1));
  const ap13 = await approve(pod13.requestId);
  check('S13 the approved request completes like any prepaid delivery', ap13.ledger?.paidStatus === 'paid' && close(Number(ap13.ledger?.advanceApplied), 165, 0.01), ap13.ledger);

  const before13b = await counts();
  const staffTooBig = data(await req('POST', '/deliveries', {
    ...S,
    json: {
      customerId: customer.id, customerName: 'Delivery Customer',
      items: [{ itemId, itemName: 'Crate', orderedQty: 9999, unitPrice: 150 }], advanceAmount: '100',
    },
  }));
  const failApprove = await req('POST', `/approvals/${staffTooBig?.requestId}/decide`, { ...A, json: { decision: 'approve' } });
  const still = data(await req('GET', `/approvals/${staffTooBig?.requestId}`, A));
  const after13b = await counts();
  check('S13 a request that no longer fits fails honestly: still pending, reason recorded, nothing created',
    failApprove.status === 422 && still?.status === 'pending' && !!still?.lastError &&
      after13b.d === before13b.d && after13b.p === before13b.p && after13b.j === before13b.j,
    { status: failApprove.status, still, before13b, after13b });
  await req('POST', `/approvals/${staffTooBig?.requestId}/cancel`, { ...S, json: {} });

  // ═════ Scenario 14: PARTIAL out of range ═════
  console.log('\n— Scenario L: PARTIAL for nothing, or more than is due');
  const d11 = await mkDelivery(1); // 165
  const over = await riderDelivers(d11.id, 'partial', line(1), '200');
  check('S14 PARTIAL above the amount due is refused (400)', over.status === 400 && JSON.stringify(over.body).includes('COLLECTED_OUT_OF_RANGE'), over.body);
  const zero = await riderDelivers(d11.id, 'partial', line(1), '0');
  check('S14 PARTIAL of zero is refused (400)', zero.status === 400, zero.body);
  const ok11 = await riderDelivers(d11.id, 'partial', line(1), '165');
  check('S14 PARTIAL for the whole amount is taken as PAID', ok11.status === 201 && ok11.body?.data?.paidStatus === 'paid', ok11.body);
  // Approved through the older review route the Android app uses, with the
  // owner's count: the rider said 165, the owner counted 100.
  const arL = bsLine(await balanceSheet(), '1100');
  const review11 = await req('PATCH', `/inventory-approvals/${ok11.requestId}/review`, { ...A, json: { action: 'approved', amountCollected: '100' } });
  check('S14 the app’s review route carries the owner’s cash count', review11.status === 200, review11.body);
  const row11 = await deliveryRow(d11.id);
  check('S14 recorded PART PAID: 100 cash, 65 left in A/R',
    row11?.paidStatus === 'partial' && close(Number(row11?.amountCollected), 100, 0.01) &&
      close(bsLine(await balanceSheet(), '1100') - arL, 65, 0.01), { row11, ar: bsLine(await balanceSheet(), '1100') - arL });

  // ═════ Scenario 15: an advance on the road cannot be deleted ═════
  console.log('\n— Scenario M: deleting the advance of a delivery on the road');
  const adv15 = bsLine(await balanceSheet(), '2400');
  const d12 = await mkDelivery(1, { prePaid: true });
  const del1 = await req('DELETE', `/payments/${d12?.advance?.paymentId}`, A);
  check('S15 refused while the delivery is open (409)', del1.status === 409, del1.body);
  const cancel12 = await req('PATCH', `/deliveries/${d12.id}/status`, { ...A, json: { status: 'cancelled', notes: 'Customer changed their mind' } });
  check('S15 delivery cancelled', cancel12.status === 200, cancel12.body);
  check('S15 the advance stays with the customer after cancelling', close(bsLine(await balanceSheet(), '2400') - adv15, 165, 0.01));
  const del2 = await req('DELETE', `/payments/${d12?.advance?.paymentId}`, A);
  check('S15 once cancelled, the receipt can be deleted (refund handled outside)', del2.status === 200, del2.body);
  bs = await assertBooksBalanced('S15 after cancel + delete');
  check('S15 2400 back to where it started', close(bsLine(bs, '2400'), adv15, 0.01), bsLine(bs, '2400'));
  await assertAdvancesTie('S15');
  await assertInventoryTies('S15');

  // ═════ Scenario F: the average MOVES while the goods are on the van ═════
  //
  // Every other scenario here returns stock at the same average it left at, so
  // the frozen line cost f equals the live average A and a restock that forgets
  // to re-average looks identical to one that remembers. This scenario is the
  // one that can tell them apart: dispatch at one cost, change the average with
  // a receipt WHILE the units are out, then bring them back.
  //
  // Before the fix the ledger moved by q x f while the valuation moved by
  // q x A, drifting the subledger from account 1200 by q x (A - f) — measured
  // at 333.35 on exactly this shape. assertInventoryTies is what catches it.
  console.log('\n— Scenario F: price changes mid-flight, then the goods come back');
  const fCostBefore = await itemCost();
  const d6 = await mkDelivery(4);                       // freezes f = fCostBefore

  // Receive 10 at DOUBLE the current cost — this is what moves A away from f.
  const po2 = data(await req('POST', '/purchase-orders', {
    ...A,
    json: {
      vendorId: vendor.id, orderDate: TODAY,
      lines: [{ description: 'Crates dearer', orderedQty: '10', unitCost: String(fCostBefore * 2), itemId }],
    },
  }));
  await req('PATCH', `/purchase-orders/${po2.id}/status`, { ...A, json: { status: 'sent' } });
  await req('POST', `/purchase-orders/${po2.id}/receive`, {
    ...A, json: { lines: [{ lineId: po2?.lines?.[0]?.id, receivedQty: '10' }] },
  });
  const costAfterReceipt = await itemCost();
  check('SF receipt moved the weighted average away from the frozen cost',
    costAfterReceipt > fCostBefore, { was: fCostBefore, now: costAfterReceipt });
  await assertInventoryTies('SF after the dearer receipt');

  // Bring the 4 dispatched units back. They must be absorbed at f, not at A.
  const qtyBeforeReturn = await qtyOnHand();
  const cancelRes = await req('PATCH', `/deliveries/${d6.id}/status`, {
    ...A, json: { status: 'cancelled', notes: 'SF re-average probe' },
  });
  check('SF delivery cancelled', cancelRes.status === 200, cancelRes.status);

  const expectedCost =
    (qtyBeforeReturn * costAfterReceipt + 4 * fCostBefore) / (qtyBeforeReturn + 4);
  const costAfterReturn = await itemCost();
  check('SF returned units absorbed at the cost they LEFT at, not today\'s average',
    close(costAfterReturn, expectedCost, 0.01),
    { expected: expectedCost, got: costAfterReturn, frozen: fCostBefore, live: costAfterReceipt });
  check('SF on-hand restored', close(await qtyOnHand(), qtyBeforeReturn + 4), await qtyOnHand());

  // THE assertion this scenario exists for.
  await assertInventoryTies('SF after a return with a moved average');
  await assertBooksBalanced('SF after a return with a moved average');

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
  await assertAdvancesTie('FINAL');
  const paidDrift = await pg.query(
    `SELECT d.reference_no, d.paid_status, i.balance, i.amount_paid
       FROM deliveries d JOIN invoices i ON i.id = d.invoice_id
      WHERE d.company_id = $1 AND d.ledger_status = 'committed' AND i.status NOT IN ('void', 'draft')
        AND NOT EXISTS (SELECT 1 FROM credit_memo_applications cma WHERE cma.invoice_id = i.id)
        AND NOT EXISTS (SELECT 1 FROM credit_memos cm WHERE cm.original_invoice_id = i.id AND cm.status <> 'void')
        AND d.paid_status IS DISTINCT FROM (CASE WHEN i.balance <= 0.0001 THEN 'paid'
                                                 WHEN i.amount_paid > 0.0001 THEN 'partial'
                                                 ELSE 'unpaid' END)`, [cid]);
  check('FINAL: every approved delivery reads its invoice’s PAID / PARTIAL / NOT PAID (I21)', paidDrift.rows.length === 0, paidDrift.rows);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fails.length) { console.log('Failed:'); fails.forEach(f => console.log(`  - ${f}`)); }
  await pg.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
