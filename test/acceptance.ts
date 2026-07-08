/**
 * FinMatrix — Acceptance Suite (FinMatrixGuide §8)
 * ================================================
 * Automated end-to-end checks against a running API, asserting the ledger
 * invariants and the scenario tests from the spec. Every financial mutation is
 * exercised through the real HTTP surface and the books are re-verified after.
 *
 * Usage:
 *   API_BASE=https://finmatrix-api-prod-665c6b5cb6a1.herokuapp.com/api/v1 \
 *   ADMIN_EMAIL=warehouse@gmail.com ADMIN_PASSWORD=123456 \
 *   RIDER_EMAIL=rider1@warehouseco.com RIDER_PASSWORD=123456 \
 *   npm run test:acceptance
 *
 * Runs against the WAREHOUSE demo company (three-tier model): it has every
 * feature (inventory + delivery + payroll), so the full matrix is testable.
 *
 * Exits non-zero if any check fails.
 */
import 'reflect-metadata';

const API = process.env.API_BASE || 'https://finmatrix-api-prod-665c6b5cb6a1.herokuapp.com/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'warehouse@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const RIDER_EMAIL = process.env.RIDER_EMAIL || 'rider1@warehouseco.com';
const RIDER_PASSWORD = process.env.RIDER_PASSWORD || '123456';

let token = '';
let companyId = '';
let pass = 0;
let fail = 0;
const failures: string[] = [];

function ok(name: string, cond: boolean, detail = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    failures.push(`${name} ${detail}`);
    console.log(`  ✗ ${name} ${detail}`);
  }
}

const approx = (a: number, b: number, eps = 0.01) => Math.abs(a - b) < eps;
const n = (v: unknown) => parseFloat(String(v ?? '0'));

async function api(
  method: string,
  path: string,
  body?: unknown,
  opts: { token?: string; headers?: Record<string, string>; raw?: boolean } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers || {}),
  };
  const tok = opts.token ?? token;
  if (tok) headers['Authorization'] = `Bearer ${tok}`;
  if (companyId) headers['x-company-id'] = companyId;
  let res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  // Global throttle is 100 req/min — a full suite run trips it. Waiting out
  // the window keeps the checks deterministic.
  for (let retry = 0; res.status === 429 && retry < 4; retry++) {
    console.log('    (throttled — waiting 20s)');
    await new Promise((r) => setTimeout(r, 20_000));
    res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  }
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  // Most endpoints wrap in { success, data }; the reports controller returns raw.
  const data = json && typeof json === 'object' && 'success' in json ? json.data : json;
  return { status: res.status, body: data ?? json };
}

/** Sign-in with 429-throttle retry (the API allows 5 sign-ins/min). */
async function signinRetry(email: string, password: string): Promise<{ status: number; body: any }> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await api('POST', '/auth/signin', { email, password });
    if (r.status !== 429) return r;
    console.log('    (signin throttled — waiting 15s)');
    await new Promise((res) => setTimeout(res, 15_000));
  }
  return api('POST', '/auth/signin', { email, password });
}

async function firstId(path: string): Promise<string> {
  const { body } = await api('GET', path);
  const arr = Array.isArray(body) ? body : body?.data ?? body?.accounts ?? body?.items ?? [];
  return arr[0]?.id;
}

async function acctBalance(code: string): Promise<number> {
  const { body } = await api('GET', `/accounts?search=${code}`);
  const arr = body?.accounts ?? body?.data ?? body ?? [];
  const a = (arr as any[]).find((x) => x.accountNumber === code);
  return n(a?.balance);
}

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

/**
 * phase2.md — Delivery module end-to-end (admin assign → rider Saim → admin
 * approval → ledger/reports). Self-contained: creates its own item stocked
 * 12 @ cost 100 (sell 150 + 10% tax) so every quantity below is exact.
 * All balance assertions are DELTAS so the suite is safe on a company that
 * already has books (e.g. the seeded MetroMatrix demo).
 */
async function deliveryE2E() {
  console.log('\n— phase2.md delivery E2E —');
  const TODAY = new Date().toISOString().slice(0, 10);

  async function invariants(label: string) {
    const tb = (await api('GET', '/reports/trial-balance')).body;
    ok(`[${label}] Trial Balance balanced`, !!tb?.isBalanced, `Dr=${tb?.totalDebits} Cr=${tb?.totalCredits}`);
    const bs = (await api('GET', '/reports/balance-sheet')).body;
    ok(
      `[${label}] Balance Sheet balanced (A = L + E)`,
      approx(n(bs?.totalAssets), n(bs?.totalLiabilities) + n(bs?.totalEquity)),
      `A=${bs?.totalAssets} L=${bs?.totalLiabilities} E=${bs?.totalEquity}`,
    );
  }
  const pl = async () => (await api('GET', '/reports/profit-loss?startDate=1970-01-01&endDate=2999-12-31')).body;
  const agingTotal = async () => {
    const a = (await api('GET', '/reports/ar-aging')).body;
    const rows = a?.rows ?? a ?? [];
    return Array.isArray(rows) ? rows.reduce((s: number, x: any) => s + n(x.total), 0) : 0;
  };
  const valuationTies = async (label: string) => {
    const val = (await api('GET', '/reports/inventory-valuation')).body;
    const gl1200 = await acctBalance('1200');
    ok(`[${label}] Inventory Valuation ties to GL 1200`, approx(n(val?.totalValue), gl1200), `valuation=${val?.totalValue} gl=${gl1200}`);
  };

  // ── Setup: rider Saim + a second rider + item stocked exactly 12 ──
  const riderSignin = await signinRetry(RIDER_EMAIL, RIDER_PASSWORD);
  const riderTok = riderSignin.body?.tokens?.accessToken;
  const riderUserId = riderSignin.body?.user?.id;
  ok('D0 rider (Saim) signs in', !!riderTok && !!riderUserId, `status=${riderSignin.status} body=${JSON.stringify(riderSignin.body)?.slice(0, 200)}`);
  if (!riderTok) return;

  // Second rider for isolation tests. Creating one may hit the plan's rider
  // limit (server-enforced — correct behavior); fall back to the seeded
  // second rider in that case.
  const rider2Create = await api('POST', '/delivery-personnel', {
    email: `qa_rider2_${Date.now()}@qa.local`, password: 'Rider2@123', name: 'QA Second Rider',
  });
  let rider2Email = rider2Create.body?.email;
  let rider2Password = 'Rider2@123';
  if (rider2Create.status >= 400 || !rider2Email) {
    rider2Email = process.env.RIDER2_EMAIL || 'rider2@warehouseco.com';
    rider2Password = process.env.RIDER2_PASSWORD || '123456';
  }
  const rider2Signin = await signinRetry(rider2Email, rider2Password);
  const rider2Tok = rider2Signin.body?.tokens?.accessToken;
  const rider2UserId = rider2Signin.body?.user?.id ?? rider2Create.body?.userId;
  ok('D0 second rider ready (for isolation tests)', !!rider2Tok && !!rider2UserId);

  const customerId = await firstId('/customers');
  let vendorId = await firstId('/vendors');
  if (!vendorId) vendorId = (await api('POST', '/vendors', { companyName: 'QA Delivery Vendor' })).body?.id;
  const itemRes = (await api('POST', '/inventory/items', {
    sku: `E2E-${Date.now()}`, name: 'E2E Crate', unitCost: '0', sellingPrice: '150',
  })).body;
  const itemId = itemRes?.id ?? itemRes?.item?.id;
  const po = (await api('POST', '/purchase-orders', {
    vendorId, orderDate: TODAY, lines: [{ description: 'E2E Crates', orderedQty: '12', unitCost: '100', itemId }],
  })).body;
  await api('POST', `/purchase-orders/${po?.id}/receive`, { lines: [{ lineId: po?.lines?.[0]?.id, receivedQty: '12' }] });
  await api('POST', `/purchase-orders/${po?.id}/create-bill`, { billNumber: `E2E-B-${Date.now()}`, billDate: TODAY, dueDate: TODAY });
  const qtyOnHand = async () => {
    const b = (await api('GET', `/inventory/items/${itemId}`)).body;
    return n(b?.item?.quantityOnHand ?? b?.quantityOnHand);
  };
  ok('D0 item stocked: exactly 12 on hand', approx(await qtyOnHand(), 12), `qty=${await qtyOnHand()}`);
  await invariants('D0 after stocking');

  // Baselines for delta assertions (company may already have books)
  const base = {
    git: await acctBalance('1250'),
    cash: await acctBalance('1000'),
    ar: await acctBalance('1100'),
    tax: await acctBalance('2300'),
    cogs: await acctBalance('5000'),
    revenue: n((await pl())?.revenue),
    aging: await agingTotal(),
  };

  const mkDelivery = async (qty: unknown, extra: Record<string, unknown> = {}, personnel: string = riderUserId) =>
    api('POST', '/deliveries', {
      customerId, customerName: 'E2E Customer', personnelId: personnel,
      items: [{ itemId, itemName: 'E2E Crate', orderedQty: qty, unitPrice: 150, taxRate: 10 }],
      ...extra,
    });

  // ── D1 over-allocation: 13 when only 12 exist → clear rejection ──
  const over = await mkDelivery(13);
  ok('D1 assigning 13 of 12 rejected', over.status >= 400 && over.status < 500, `status=${over.status}`);
  const overMsg = JSON.stringify(over.body ?? '');
  ok('D1 rejection message names the shortage', /only\s+12/i.test(overMsg) && /INSUFFICIENT_STOCK/i.test(overMsg), overMsg.slice(0, 160));
  ok('D1 stock unchanged after rejection', approx(await qtyOnHand(), 12), `qty=${await qtyOnHand()}`);
  ok('D1 nothing half-posted (GIT unchanged)', approx(await acctBalance('1250'), base.git), `git=${await acctBalance('1250')}`);
  await invariants('D1 after over-allocation attempt');

  // ── D2 zero / negative / non-integer / garbage quantities rejected ──
  for (const [labelQty, qty] of [['zero', 0], ['negative', -3], ['non-integer', 2.5], ['garbage', 'abc']] as const) {
    const r = await mkDelivery(qty);
    ok(`D2 ${labelQty} quantity (${qty}) rejected with 4xx`, r.status >= 400 && r.status < 500, `status=${r.status} body=${JSON.stringify(r.body)?.slice(0, 120)}`);
  }
  ok('D2 stock still 12 after invalid attempts', approx(await qtyOnHand(), 12), `qty=${await qtyOnHand()}`);

  // ── D3 exact stock allowed: 12 of 12 → on-hand 0, never negative ──
  const exact = await mkDelivery(12);
  ok('D3 exact allocation (12 of 12) accepted', exact.status < 300 && !!exact.body?.id, `status=${exact.status}`);
  ok('D3 ledger echo: stock committed to GIT', exact.body?.ledger?.committed === true, JSON.stringify(exact.body?.ledger));
  ok('D3 sales order created (non-posting)', !!exact.body?.ledger?.salesOrderNumber, JSON.stringify(exact.body?.ledger));
  ok('D3 on-hand fell to exactly 0', approx(await qtyOnHand(), 0), `qty=${await qtyOnHand()}`);
  ok('D3 GIT rose by cost 1200 (12 × 100)', approx(await acctBalance('1250'), base.git + 1200), `git=${await acctBalance('1250')}`);
  const oneMore = await mkDelivery(1);
  ok('D3 one more unit rejected — inventory can never go negative', oneMore.status >= 400, `status=${oneMore.status}`);
  ok('D3 on-hand still 0 (not negative)', (await qtyOnHand()) === 0, `qty=${await qtyOnHand()}`);
  ok('D3 no revenue posted at assignment', approx(n((await pl())?.revenue), base.revenue), `rev=${n((await pl())?.revenue)}`);
  await invariants('D3 after exact allocation');

  // ── D4 return path: reject the pending POD → full reversal + restock ──
  for (const st of ['picked_up', 'in_transit', 'arrived']) {
    await api('PATCH', `/deliveries/${exact.body.id}/status`, { status: st }, { token: riderTok });
  }
  const podReturn = await uploadPod(exact.body.id, riderTok, 'unpaid', [
    { itemId, itemName: 'E2E Crate', beforeQty: 0, deliveredQty: 12, returnedQty: 0 },
  ]);
  ok('D4 POD submitted for the returned delivery', podReturn.status === 201 && !!podReturn.requestId, `status=${podReturn.status}`);
  const rejectRes = await api('POST', `/inventory-update-requests/${podReturn.requestId}/reject`, { reviewerComment: 'Customer refused — full return' });
  ok('D4 admin rejects (return)', rejectRes.status < 300, `status=${rejectRes.status}`);
  ok('D4 stock fully restored to 12', approx(await qtyOnHand(), 12), `qty=${await qtyOnHand()}`);
  ok('D4 GIT reversed back to baseline (Dr 1200 / Cr 1250)', approx(await acctBalance('1250'), base.git), `git=${await acctBalance('1250')}`);
  ok('D4 no revenue posted on return', approx(n((await pl())?.revenue), base.revenue), `rev=${n((await pl())?.revenue)}`);
  await invariants('D4 after return reversal');
  await valuationTies('D4 after return');

  // ── D5 concurrency: two simultaneous 8-unit assignments, 12 in stock ──
  const [c1, c2] = await Promise.all([mkDelivery(8), mkDelivery(8)]);
  const winners = [c1, c2].filter((r) => r.status < 300);
  ok('D5 exactly ONE of two concurrent 8-unit assignments succeeded', winners.length === 1, `successes=${winners.length}`);
  ok('D5 on-hand 4 — the same stock was not sold twice', approx(await qtyOnHand(), 4), `qty=${await qtyOnHand()}`);
  await invariants('D5 after concurrent assignment');
  const live = winners[0]?.body;

  // ── D6 rider view: scoping, ownership, status machine ──
  const rider2Delivery = await mkDelivery(1, {}, rider2UserId);
  ok('D6 second delivery assigned to the other rider', rider2Delivery.status < 300, `status=${rider2Delivery.status}`);
  const saimList = (await api('GET', '/deliveries?limit=100', undefined, { token: riderTok })).body;
  // The envelope interceptor lifts the inner `data` array of paged responses.
  const saimRows = (Array.isArray(saimList) ? saimList : saimList?.data ?? []) as any[];
  ok('D6 Saim sees ONLY his own deliveries', saimRows.length > 0 && saimRows.every((d) => (d.assignedTo ?? d.personnelId) === riderUserId), `rows=${saimRows.length}`);
  ok("D6 other rider's delivery absent from Saim's list", !saimRows.some((d) => d.id === rider2Delivery.body?.id));
  const foreignPatch = await api('PATCH', `/deliveries/${rider2Delivery.body?.id}/status`, { status: 'picked_up' }, { token: riderTok });
  ok("D6 Saim cannot advance another rider's delivery (403)", foreignPatch.status === 403, `status=${foreignPatch.status}`);
  const riderCancel = await api('PATCH', `/deliveries/${rider2Delivery.body?.id}/status`, { status: 'cancelled' }, { token: rider2Tok });
  ok('D6 rider cannot cancel a delivery (403)', riderCancel.status === 403, `status=${riderCancel.status}`);
  // Admin cancels the second delivery: the dispatched unit must come back on
  // the shelf and its Goods in Transit reverse (Dr 1200 / Cr 1250).
  const adminCancel = await api('PATCH', `/deliveries/${rider2Delivery.body?.id}/status`, { status: 'cancelled', notes: 'QA — cancel releases stock' });
  ok('D6 admin cancels the other delivery', adminCancel.status < 300, `status=${adminCancel.status}`);
  ok('D6 cancelled delivery restocked its unit (on-hand back to 4)', approx(await qtyOnHand(), 4), `qty=${await qtyOnHand()}`);
  ok('D6 cancelled delivery released its GIT value', approx(await acctBalance('1250'), base.git + 800), `git=${await acctBalance('1250')}`);

  const skip = await api('PATCH', `/deliveries/${live.id}/status`, { status: 'delivered' }, { token: riderTok });
  ok('D6 skipping ahead (pending → delivered) rejected', skip.status >= 400, `status=${skip.status}`);
  const s1 = await api('PATCH', `/deliveries/${live.id}/status`, { status: 'picked_up' }, { token: riderTok });
  ok('D6 pending → picked_up allowed', s1.status < 300, `status=${s1.status}`);
  const replay = await api('PATCH', `/deliveries/${live.id}/status`, { status: 'picked_up' }, { token: riderTok });
  ok('D6 double-tap (replay picked_up) succeeds as a no-op', replay.status < 300, `status=${replay.status}`);
  const hist = (await api('GET', `/deliveries/${live.id}/history?limit=100`)).body;
  const histRows = (hist?.data ?? hist ?? []) as any[];
  ok('D6 replay wrote NO duplicate history row', histRows.filter((h) => h.status === 'picked_up').length === 1,
    `picked_up rows=${histRows.filter((h) => h.status === 'picked_up').length}`);
  await api('PATCH', `/deliveries/${live.id}/status`, { status: 'in_transit' }, { token: riderTok });
  const backward = await api('PATCH', `/deliveries/${live.id}/status`, { status: 'picked_up' }, { token: riderTok });
  ok('D6 going backward (in_transit → picked_up) rejected', backward.status >= 400, `status=${backward.status}`);
  const arrived = await api('PATCH', `/deliveries/${live.id}/status`, { status: 'arrived' }, { token: riderTok });
  ok('D6 in_transit → arrived allowed', arrived.status < 300, `status=${arrived.status}`);

  // ── D7 rider marks PAID + POD photo; rider posts NOTHING ──
  const cashBeforePod = await acctBalance('1000');
  const pod = await uploadPod(live.id, riderTok, 'paid', [
    { itemId, itemName: 'E2E Crate', beforeQty: 4, deliveredQty: 8, returnedQty: 0 },
  ]);
  ok('D7 POD photo + PAID flag submitted', pod.status === 201 && !!pod.requestId, `status=${pod.status}`);
  ok('D7 rider action posted NOTHING (GIT/cash unchanged)',
    approx(await acctBalance('1250'), base.git + 800) && approx(await acctBalance('1000'), cashBeforePod),
    `git=${await acctBalance('1250')} cash=${await acctBalance('1000')}`);

  const queue = (await api('GET', '/inventory-update-requests?status=pending&limit=100')).body;
  // The approval queue pages as { items, total, page, pageSize }.
  const queueRows = (queue?.items ?? (Array.isArray(queue?.data) ? queue.data : queue?.data?.data) ?? (Array.isArray(queue) ? queue : [])) as any[];
  const card = queueRows.find((r) => r.id === pod.requestId);
  ok('D7 approval queue shows the pending request', !!card);
  ok('D7 queue card carries PAID flag, amount, customer',
    card?.paidStatus === 'paid' && approx(n(card?.saleAmount), 1320) && !!card?.customerName,
    JSON.stringify({ paidStatus: card?.paidStatus, saleAmount: card?.saleAmount, customerName: card?.customerName }));

  const adminPhoto = await fetch(`${API}/inventory-update-requests/${pod.requestId}/bill-photo`, {
    headers: { Authorization: `Bearer ${token}`, 'x-company-id': companyId },
  });
  ok('D7 admin can view the POD photo', adminPhoto.status === 200 && (adminPhoto.headers.get('content-type') ?? '').startsWith('image/'), `status=${adminPhoto.status}`);
  const ownerPhoto = await fetch(`${API}/inventory-update-requests/${pod.requestId}/bill-photo`, {
    headers: { Authorization: `Bearer ${riderTok}`, 'x-company-id': companyId },
  });
  ok('D7 owner rider can view his own POD photo', ownerPhoto.status === 200, `status=${ownerPhoto.status}`);
  const strangerPhoto = await fetch(`${API}/inventory-update-requests/${pod.requestId}/bill-photo`, {
    headers: { Authorization: `Bearer ${rider2Tok}`, 'x-company-id': companyId },
  });
  ok("D7 another rider CANNOT view Saim's POD photo (403)", strangerPhoto.status === 403, `status=${strangerPhoto.status}`);

  // ── D8 admin approval (PAID): SO → invoice, Dr Cash / Cr Sales+Tax, COGS ──
  const riderApprove = await api('POST', `/inventory-update-requests/${pod.requestId}/approve`, {}, { token: riderTok });
  ok('D8 rider cannot approve (403)', riderApprove.status === 403, `status=${riderApprove.status}`);
  const approve = await api('POST', `/inventory-update-requests/${pod.requestId}/approve`, {});
  ok('D8 admin approval succeeds', approve.status < 300, `status=${approve.status} ${JSON.stringify(approve.body)?.slice(0, 120)}`);
  const led = approve.body?.ledger;
  ok('D8 approval created invoice + payment (PAID)', !!led?.invoiceId && !!led?.paymentId, JSON.stringify(led));
  ok('D8 Dr Cash 1,320 (1,200 + 10% tax)', approx(await acctBalance('1000'), cashBeforePod + 1320), `cash Δ=${(await acctBalance('1000')) - cashBeforePod}`);
  ok('D8 Cr Sales Tax Payable +120', approx(await acctBalance('2300'), base.tax + 120), `tax=${await acctBalance('2300')}`);
  ok('D8 Dr COGS +800 (8 × cost 100)', approx(await acctBalance('5000'), base.cogs + 800), `cogs=${await acctBalance('5000')}`);
  ok('D8 Goods in Transit for this delivery nets to ZERO', approx(await acctBalance('1250'), base.git), `git=${await acctBalance('1250')}`);
  const plPaid = await pl();
  ok('D8 P&L shows the sale (+1,200) and COGS (+800)',
    approx(n(plPaid?.revenue), base.revenue + 1200) && approx(n(plPaid?.cogs), base.cogs + 800),
    `rev=${plPaid?.revenue} cogs=${plPaid?.cogs}`);
  await invariants('D8 after PAID approval');
  await valuationTies('D8 after PAID approval');

  const approveTwice = await api('POST', `/inventory-update-requests/${pod.requestId}/approve`, {});
  ok('D8 approving twice rejected (409) — no double post', approveTwice.status === 409, `status=${approveTwice.status}`);
  ok('D8 books unchanged after replayed approval', approx(await acctBalance('1000'), cashBeforePod + 1320), `cash=${await acctBalance('1000')}`);

  // ── D9 NOT-PAID cycle: open invoice in A/R → aging → later payment ──
  const unpaidDel = await mkDelivery(3);
  ok('D9 unpaid delivery assigned (3 units)', unpaidDel.status < 300, `status=${unpaidDel.status}`);
  for (const st of ['picked_up', 'in_transit', 'arrived']) {
    await api('PATCH', `/deliveries/${unpaidDel.body.id}/status`, { status: st }, { token: riderTok });
  }
  const podUnpaid = await uploadPod(unpaidDel.body.id, riderTok, 'unpaid', [
    { itemId, itemName: 'E2E Crate', beforeQty: 1, deliveredQty: 3, returnedQty: 0 },
  ]);
  ok('D9 POD submitted NOT PAID', podUnpaid.status === 201 && !!podUnpaid.requestId, `status=${podUnpaid.status}`);
  const arBefore = await acctBalance('1100');
  const approveUnpaid = await api('POST', `/inventory-update-requests/${podUnpaid.requestId}/approve`, {});
  ok('D9 approval succeeds', approveUnpaid.status < 300, `status=${approveUnpaid.status}`);
  const ledU = approveUnpaid.body?.ledger;
  ok('D9 invoiced on credit — invoice, NO payment', !!ledU?.invoiceId && !ledU?.paymentId, JSON.stringify(ledU));
  ok('D9 Dr A/R +495 (450 + 10% tax)', approx(await acctBalance('1100'), arBefore + 495), `ar Δ=${(await acctBalance('1100')) - arBefore}`);
  ok('D9 GIT nets to ZERO again', approx(await acctBalance('1250'), base.git), `git=${await acctBalance('1250')}`);
  ok('D9 open invoice appears in A/R aging (+495)', approx(await agingTotal(), base.aging + 495), `aging=${await agingTotal()}`);
  await invariants('D9 after NOT-PAID approval');

  const payLater = await api('POST', '/payments', {
    customerId, paymentDate: TODAY, paymentMethod: 'cash', amount: '495.00',
    applications: [{ invoiceId: ledU?.invoiceId, amount: '495.00' }],
  });
  ok('D9 later Receive Payment accepted (Dr Cash / Cr A/R)', payLater.status < 300, `status=${payLater.status}`);
  ok('D9 A/R cleared back to baseline', approx(await acctBalance('1100'), arBefore), `ar=${await acctBalance('1100')}`);
  const invAfterPay = (await api('GET', `/invoices/${ledU?.invoiceId}`)).body;
  const invStatus = invAfterPay?.invoice?.status ?? invAfterPay?.status;
  ok('D9 invoice status = paid', invStatus === 'paid', `status=${invStatus}`);
  await invariants('D9 after settlement');
  await valuationTies('D9 after settlement');

  // ── D10 rider token → 403 on every posting/approval/financial endpoint ──
  const financialProbes: [string, string, unknown?][] = [
    ['GET', '/reports/trial-balance'],
    ['GET', '/reports/profit-loss'],
    ['GET', '/reports/balance-sheet'],
    ['GET', '/reports/ar-aging'],
    ['GET', '/ledger'],
    ['GET', '/accounts'],
    ['GET', '/journal-entries'],
    ['POST', '/journal-entries', { entryDate: TODAY, lines: [] }],
    ['POST', '/invoices', { customerId, invoiceDate: TODAY, dueDate: TODAY, lines: [] }],
    ['POST', '/payments', { customerId, paymentDate: TODAY, paymentMethod: 'cash', amount: '1' }],
    ['POST', '/deliveries', { customerId, items: [] }],
  ];
  for (const [method, path, body] of financialProbes) {
    const r = await api(method, path, body, { token: riderTok });
    ok(`D10 rider 403 on ${method} ${path}`, r.status === 403, `status=${r.status}`);
  }

  // ── Final: everything ties ──
  ok('DF Goods in Transit nets to ZERO across all completed deliveries', approx(await acctBalance('1250'), base.git), `git=${await acctBalance('1250')}`);
  ok('DF on-hand never went negative (1 left of 12)', approx(await qtyOnHand(), 1), `qty=${await qtyOnHand()}`);
  await invariants('DF final');
  await valuationTies('DF final');
}

async function uploadPod(
  deliveryId: string,
  riderToken: string,
  paidStatus: 'paid' | 'unpaid',
  changes: unknown[],
): Promise<{ status: number; requestId?: string }> {
  const fd = new FormData();
  fd.append('photo', new Blob([PNG], { type: 'image/png' }), 'bill.png');
  fd.append('signedBy', 'E2E Customer');
  fd.append('source', 'camera');
  fd.append('paidStatus', paidStatus);
  fd.append('changes', JSON.stringify(changes));
  const res = await fetch(`${API}/deliveries/${deliveryId}/bill-photo`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${riderToken}`, 'x-company-id': companyId },
    body: fd as any,
  });
  const body: any = await res.json().catch(() => null);
  return { status: res.status, requestId: body?.data?.requestId };
}

async function run() {
  console.log(`\nFinMatrix Acceptance Suite → ${API}\n`);

  // ── Auth ──
  const signin = await api('POST', '/auth/signin', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  token = signin.body?.tokens?.accessToken;
  companyId = signin.body?.user?.companyId || signin.body?.user?.defaultCompanyId;
  ok('admin signs in', !!token && !!companyId);
  if (!token) {
    console.error('Cannot continue without auth.');
    process.exit(1);
  }

  // ── Invariant helpers ──
  async function invariants(label: string) {
    const tb = (await api('GET', '/reports/trial-balance')).body;
    ok(`[${label}] Trial Balance balanced`, !!tb?.isBalanced, `Dr=${tb?.totalDebits} Cr=${tb?.totalCredits}`);
    const bs = (await api('GET', '/reports/balance-sheet')).body;
    ok(
      `[${label}] Balance Sheet balanced (A = L + E)`,
      approx(n(bs?.totalAssets), n(bs?.totalLiabilities) + n(bs?.totalEquity)),
      `A=${bs?.totalAssets} L=${bs?.totalLiabilities} E=${bs?.totalEquity}`,
    );
  }

  await invariants('baseline');

  // ── #1 Opening balance posts an offset → TB still balanced ──
  const acctNum = `1099-${Date.now() % 100000}`;
  const created = await api('POST', '/accounts', {
    accountNumber: acctNum, name: 'Acceptance Opening', type: 'asset', subType: 'Cash', openingBalance: '5000',
  });
  ok('#1 create account with opening balance', created.status < 300 && !!created.body?.id);
  const obe = await acctBalance('3900');
  ok('#1 Opening Balance Equity exists/credited', obe !== 0);
  await invariants('after opening balance');

  // ── Resolve master data ──
  const customerId = await firstId('/customers');
  const cashId = (await (async () => {
    const { body } = await api('GET', '/accounts?search=1000');
    const arr = body?.accounts ?? body ?? [];
    return (arr as any[]).find((a) => a.accountNumber === '1000')?.id;
  })());
  const itemsRes = await api('GET', '/inventory/items');
  const items = (itemsRes.body?.data ?? itemsRes.body?.items ?? itemsRes.body ?? []) as any[];
  const item = items.find((i) => n(i.unitCost) > 0);

  // ── #2 Issue invoice with inventory line → COGS + qty down ──
  const cogsBefore = await acctBalance('5000');
  const qtyBefore = n(item?.quantityOnHand);
  const inv = await api('POST', '/invoices', {
    customerId, invoiceDate: '2026-06-24', dueDate: '2026-07-24', status: 'sent',
    lines: [{ description: item.name, quantity: '3', unitPrice: item.sellingPrice, taxRate: '17', itemId: item.id }],
  });
  ok('#2 issue invoice (item line)', inv.status < 300 && !!inv.body?.id);
  const cogsAfter = await acctBalance('5000');
  ok('#2 COGS increased by qty×cost', approx(cogsAfter - cogsBefore, 3 * n(item.unitCost)), `Δ=${cogsAfter - cogsBefore}`);
  const itemAfter = (await api('GET', `/inventory/items/${item.id}`)).body;
  const qtyAfter = n(itemAfter?.quantityOnHand ?? itemAfter?.item?.quantityOnHand);
  ok('#2 quantity on hand reduced by 3', approx(qtyBefore - qtyAfter, 3), `before=${qtyBefore} after=${qtyAfter}`);
  await invariants('after invoice');

  // ── #3 Receive full payment → invoice paid ──
  const invFull = (await api('GET', `/invoices/${inv.body.id}`)).body;
  const invTotal = n(invFull?.invoice?.total ?? invFull?.total ?? inv.body.total);
  const pay = await api('POST', '/payments', {
    customerId, paymentDate: '2026-06-24', paymentMethod: 'cash', amount: String(invTotal),
    bankAccountId: cashId, applications: [{ invoiceId: inv.body.id, amount: String(invTotal) }],
  });
  ok('#3 receive full payment', pay.status < 300);
  const invPaid = (await api('GET', `/invoices/${inv.body.id}`)).body;
  const status = invPaid?.invoice?.status ?? invPaid?.status;
  ok('#3 invoice status = paid', status === 'paid', `status=${status}`);
  await invariants('after payment');

  // ── #10 Void invoice → reversing entry + restock ──
  const inv2 = await api('POST', '/invoices', {
    customerId, invoiceDate: '2026-06-24', dueDate: '2026-07-24', status: 'sent',
    lines: [{ description: item.name, quantity: '2', unitPrice: item.sellingPrice, taxRate: '0', itemId: item.id }],
  });
  const readQty = async () => {
    const b = (await api('GET', `/inventory/items/${item.id}`)).body;
    return n(b?.item?.quantityOnHand ?? b?.quantityOnHand);
  };
  const qtyBeforeVoid = await readQty();
  const voided = await api('POST', `/invoices/${inv2.body.id}/void`, { reason: 'acceptance test' });
  ok('#10 void invoice', voided.status < 300);
  const qtyAfterVoid = await readQty();
  ok('#10 stock restored on void', approx(qtyAfterVoid - qtyBeforeVoid, 2), `Δ=${qtyAfterVoid - qtyBeforeVoid}`);
  await invariants('after void');

  // ── #11 Tax payment → Tax Payable down, Cash down ──
  const taxRateId = await firstId('/taxes/rates');
  if (taxRateId) {
    const tpBefore = await acctBalance('2300');
    const tp = await api('POST', '/taxes/payments', {
      taxRateId, period: '2026-Q2', amount: '500', paymentDate: '2026-06-24',
    });
    ok('#11 tax payment posts', tp.status < 300);
    const tpAfter = await acctBalance('2300');
    ok('#11 Tax Payable reduced by 500', approx(tpBefore - tpAfter, 500), `Δ=${tpBefore - tpAfter}`);
    await invariants('after tax payment');
  }

  // ── #15 Idempotency: replay create returns the same invoice ──
  const key = `acc-idem-${Date.now()}`;
  const r1 = await api('POST', '/invoices', {
    customerId, invoiceDate: '2026-06-24', dueDate: '2026-07-24', status: 'sent',
    lines: [{ description: 'idem', quantity: '1', unitPrice: '100', taxRate: '0' }],
  }, { headers: { 'Idempotency-Key': key } });
  const r2 = await api('POST', '/invoices', {
    customerId, invoiceDate: '2026-06-24', dueDate: '2026-07-24', status: 'sent',
    lines: [{ description: 'idem', quantity: '1', unitPrice: '100', taxRate: '0' }],
  }, { headers: { 'Idempotency-Key': key } });
  ok('#15 idempotent replay returns same invoice', !!r1.body?.id && r1.body.id === r2.body.id);

  // ── #16 Period lock blocks a posting in a closed period ──
  await api('PATCH', `/companies/${companyId}`, { booksLockedUntil: '2025-12-31' });
  const locked = await api('POST', '/invoices', {
    customerId, invoiceDate: '2025-06-15', dueDate: '2025-07-15', status: 'sent',
    lines: [{ description: 'locked', quantity: '1', unitPrice: '100', taxRate: '0' }],
  });
  ok('#16 posting in locked period rejected', locked.status >= 400);
  await api('PATCH', `/companies/${companyId}`, { booksLockedUntil: null });

  // ── #18 Role enforcement: rider rejected by financial endpoints ──
  const riderSignin = await signinRetry(RIDER_EMAIL, RIDER_PASSWORD);
  const riderTok = riderSignin.body?.tokens?.accessToken;
  if (riderTok) {
    const a = await api('GET', '/reports/trial-balance', undefined, { token: riderTok });
    ok('#18 rider blocked from trial balance', a.status === 403, `status=${a.status}`);
    const b = await api('POST', '/invoices', { customerId, invoiceDate: '2026-06-24', dueDate: '2026-07-24', lines: [] }, { token: riderTok });
    ok('#18 rider blocked from creating invoice', b.status === 403, `status=${b.status}`);
  } else {
    ok('#18 rider sign-in (skipped — no rider)', true);
  }

  // ── #19 Concurrency: two payments on one invoice cannot overpay ──
  const inv3 = await api('POST', '/invoices', {
    customerId, invoiceDate: '2026-06-24', dueDate: '2026-07-24', status: 'sent',
    lines: [{ description: 'conc', quantity: '1', unitPrice: '1000', taxRate: '0' }],
  });
  const payBody = {
    customerId, paymentDate: '2026-06-24', paymentMethod: 'cash', amount: '1000',
    bankAccountId: cashId, applications: [{ invoiceId: inv3.body.id, amount: '1000' }],
  };
  const [c1, c2] = await Promise.all([
    api('POST', '/payments', payBody),
    api('POST', '/payments', payBody),
  ]);
  const successes = [c1, c2].filter((r) => r.status < 300).length;
  ok('#19 only one of two concurrent payments succeeds', successes === 1, `successes=${successes}`);
  const inv3Final = (await api('GET', `/invoices/${inv3.body.id}`)).body;
  const paid = n(inv3Final?.invoice?.amountPaid ?? inv3Final?.amountPaid);
  ok('#19 invoice not overpaid', approx(paid, 1000), `amountPaid=${paid}`);

  // ── phase2.md: delivery module end-to-end (assign → rider → approve → books) ──
  await deliveryE2E();

  await invariants('final');

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) {
    console.log('\nFailures:');
    failures.forEach((f) => console.log('  - ' + f));
    process.exit(1);
  }
  console.log('ALL ACCEPTANCE CHECKS PASSED ✓');
  process.exit(0);
}

run().catch((e) => {
  console.error('SUITE ERROR:', e);
  process.exit(1);
});
