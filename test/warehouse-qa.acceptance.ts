/**
 * QA.md — WAREHOUSE + DELIVERY-PERSONNEL end-to-end audit.
 * ========================================================
 * Runs as the REAL demo users (warehouse@gmail.com + rider1/rider2 from
 * CREDENTIALS.md) against a running API, posting real entries. Every report
 * assertion is DELTA-based so it holds on non-empty books. After every step:
 * Trial Balance balances, Balance Sheet balances, Inventory Valuation ties to
 * BS 1200, and Goods in Transit nets to zero for completed deliveries.
 * The exact journal entry each action produced is captured from the GL
 * (new rows since the step marker) and printed expected-vs-actual.
 *
 * Phases (QA.md): 1 purchase cycle · 2 masters · 3a-3h delivery↔accounting ·
 * 4 reports tie-out.
 *
 * Run:
 *   BASE_URL=http://localhost:3001/api/v1 \
 *   PG_URL=postgres://finmatrix_user:pass@localhost:5432/finmatrix_qa \
 *   npx ts-node -r tsconfig-paths/register test/warehouse-qa.acceptance.ts
 */
/* eslint-disable @typescript-eslint/no-var-requires */
export {};
const { Client } = require('pg');

const BASE = process.env.BASE_URL || 'http://localhost:3001/api/v1';
const PG_URL = process.env.PG_URL as string;
const WH_EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const WH_PASSWORD = process.env.WH_PASSWORD || '123456';
const R1_EMAIL = process.env.R1_EMAIL || 'rider1@warehouseco.com';
const R2_EMAIL = process.env.R2_EMAIL || 'rider2@warehouseco.com';
const RIDER_PASSWORD = process.env.RIDER_PASSWORD || '123456';
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
}
const close = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

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
  for (let attempt = 0; attempt < 8; attempt++) {
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

  console.log(`\n=== QA.md warehouse + delivery-personnel audit @ ${BASE} ===\n`);

  // ── Sign in the three real test users ────────────────────────────────────
  const wh = data(await signin(WH_EMAIL, WH_PASSWORD));
  const T = wh?.tokens?.accessToken;
  const cid = wh?.companyId;
  check('P0 warehouse admin signs in (active, warehouse tier)', !!T && !!cid && wh?.companyType === 'warehouse', { type: wh?.companyType, status: wh?.companyStatus });
  const A = { token: T, companyId: cid };

  const r1 = data(await signin(R1_EMAIL, RIDER_PASSWORD));
  const r2 = data(await signin(R2_EMAIL, RIDER_PASSWORD));
  const RT1 = r1?.tokens?.accessToken;
  const RT2 = r2?.tokens?.accessToken;
  check('P0 both riders sign in', !!RT1 && !!RT2);
  const R1 = { token: RT1, companyId: cid };
  const R2 = { token: RT2, companyId: cid };
  const rider1UserId = r1?.user?.id;

  // ── Report + JE-capture helpers ──────────────────────────────────────────
  const trialBalance = async () => (await req('GET', `/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31`, A)).body;
  const balanceSheet = async () => (await req('GET', `/reports/balance-sheet?asOfDate=${TODAY}`, A)).body;
  const valuation = async () => (await req('GET', `/reports/inventory-valuation`, A)).body;
  const profitLoss = async () => (await req('GET', `/reports/profit-loss?startDate=1970-01-01&endDate=2999-12-31`, A)).body;
  const bsLine = (bs: any, code: string): number => {
    for (const sect of ['assets', 'liabilities', 'equity']) {
      const row = (bs?.[sect] ?? []).find((x: any) => x.accountCode === code);
      if (row) return Number(row.amount);
    }
    return 0;
  };

  // JE capture: all GL rows this company wrote after the marker.
  let glMarker = new Date();
  const markStep = () => { glMarker = new Date(); };
  const capturedJE = async (): Promise<Array<{ acct: string; dr: number; cr: number; source: string; sourceId: string }>> => {
    const r = await pg.query(
      `SELECT a.account_number AS acct, gl.debit::numeric AS dr, gl.credit::numeric AS cr,
              gl.source_type AS source, gl.source_id AS source_id
         FROM general_ledger gl JOIN accounts a ON a.id = gl.account_id
        WHERE gl.company_id = $1 AND gl.created_at > $2
        ORDER BY gl.created_at, a.account_number`, [cid, glMarker]);
    return r.rows.map((x: any) => ({ acct: x.acct, dr: Number(x.dr), cr: Number(x.cr), source: x.source, sourceId: x.source_id }));
  };
  const jeNet = (je: Array<{ acct: string; dr: number; cr: number }>, acct: string) =>
    je.filter(l => l.acct === acct).reduce((s, l) => s + l.dr - l.cr, 0);
  const printJE = (label: string, je: Array<{ acct: string; dr: number; cr: number; source: string }>) => {
    console.log(`    JE[${label}]: ${je.length === 0 ? '(no GL rows — non-posting)' :
      je.map(l => `${l.dr > 0 ? 'Dr' : 'Cr'} ${l.acct} ${l.dr > 0 ? l.dr : l.cr} (${l.source})`).join('; ')}`);
  };

  let step = 0;
  const assertBooksBalanced = async (label: string) => {
    step++;
    const tb = await trialBalance();
    const bs = await balanceSheet();
    check(`[${step}] ${label} — TB balanced (Dr ${tb?.totalDebits} = Cr ${tb?.totalCredits})`,
      tb?.isBalanced === true && close(Number(tb?.totalDebits), Number(tb?.totalCredits), 0.005), tb?.totalDebits);
    check(`[${step}] ${label} — BS balanced (A = L + E)`,
      bs?.isBalanced === true && close(Number(bs?.totalAssets), Number(bs?.totalLiabilities) + Number(bs?.totalEquity), 0.01),
      { a: bs?.totalAssets, l: bs?.totalLiabilities, e: bs?.totalEquity });
    return bs;
  };
  const assertInventoryTies = async (label: string) => {
    const bs = await balanceSheet();
    const val = await valuation();
    check(`${label} — BS Inventory 1200 = Inventory Valuation`,
      close(bsLine(bs, '1200'), Number(val?.totalValue), 0.01),
      { gl1200: bsLine(bs, '1200'), valuation: val?.totalValue });
  };

  const itemQty = async (id: string) => Number((data(await req('GET', `/inventory/items/${id}`, A)))?.quantityOnHand);

  // Baselines (books are non-empty — everything below is deltas)
  let bs0 = await balanceSheet();
  const base = {
    cash: bsLine(bs0, '1000'), ar: bsLine(bs0, '1100'), inv: bsLine(bs0, '1200'),
    git: bsLine(bs0, '1250'), ap: bsLine(bs0, '2000'), grni: bsLine(bs0, '2050'), tax: bsLine(bs0, '2300'),
  };
  const pl0 = await profitLoss();
  const baseRev = Number(pl0?.revenue ?? 0);
  const baseCogs = Number(pl0?.cogs ?? 0);
  console.log(`  (baseline: cash ${base.cash}, A/R ${base.ar}, inv ${base.inv}, GIT ${base.git}, A/P ${base.ap}, GRNI ${base.grni})`);

  // ═════ PHASE 1 — INVENTORY & PURCHASE CYCLE ═════
  console.log('\n— PHASE 1: purchase cycle (PO → receive → bill)');
  const suffix = Date.now();
  markStep();
  const itemA = data(await req('POST', '/inventory/items', { ...A, json: { sku: `QA-A-${suffix}`, name: 'QA Widget A', unitCost: '0', sellingPrice: '150' } }));
  const itemB = data(await req('POST', '/inventory/items', { ...A, json: { sku: `QA-B-${suffix}`, name: 'QA Widget B', unitCost: '0', sellingPrice: '60' } }));
  const idA = itemA?.id ?? itemA?.item?.id;
  const idB = itemB?.id ?? itemB?.item?.id;
  check('P1.1 two items created, on-hand 0', !!idA && !!idB && (await itemQty(idA)) === 0 && (await itemQty(idB)) === 0);
  let je = await capturedJE();
  printJE('create items', je);
  check('P1.1 creating items posts NOTHING', je.length === 0, je);

  markStep();
  const vendor = data(await req('POST', '/vendors', { ...A, json: { companyName: `QA Supplier ${suffix}` } }));
  const po = data(await req('POST', '/purchase-orders', {
    ...A, json: { vendorId: vendor.id, orderDate: TODAY, lines: [
      { description: 'Widget A', orderedQty: '30', unitCost: '100', itemId: idA },
      { description: 'Widget B', orderedQty: '50', unitCost: '40', itemId: idB },
    ] },
  }));
  check('P1.2 PO created', !!po?.id && Array.isArray(po?.lines) && po.lines.length === 2, po?.id);
  je = await capturedJE();
  printJE('create PO', je);
  check('P1.2 PO posts NOTHING', je.length === 0, je);
  let bs = await assertBooksBalanced('P1.2 after PO');

  markStep();
  const recv = await req('POST', `/purchase-orders/${po.id}/receive`, { ...A, json: { lines: [
    { lineId: po.lines[0].id, receivedQty: '30' },
    { lineId: po.lines[1].id, receivedQty: '50' },
  ] } });
  check('P1.3 receive accepted', recv.status === 200 || recv.status === 201, recv.status);
  je = await capturedJE();
  printJE('receive PO (expect Dr 1200 5000 / Cr 2050 5000)', je);
  check('P1.3 receipt posted Dr Inventory 5000', close(jeNet(je, '1200'), 5000), jeNet(je, '1200'));
  check('P1.3 receipt posted Cr GRNI 5000', close(jeNet(je, '2050'), -5000), jeNet(je, '2050'));
  check('P1.3 on-hand rose (A=30, B=50)', (await itemQty(idA)) === 30 && (await itemQty(idB)) === 50);
  bs = await assertBooksBalanced('P1.3 after receipt');
  check('P1.3 BS Inventory +5000', close(bsLine(bs, '1200') - base.inv, 5000), bsLine(bs, '1200') - base.inv);
  check('P1.3 GRNI +5000 (liability up)', close(bsLine(bs, '2050') - base.grni, 5000), bsLine(bs, '2050') - base.grni);
  await assertInventoryTies('P1.3');

  markStep();
  const bill = await req('POST', `/purchase-orders/${po.id}/create-bill`, { ...A, json: { billNumber: `QA-BILL-${suffix}`, billDate: TODAY, dueDate: TODAY } });
  check('P1.4 vendor bill accepted', bill.status === 200 || bill.status === 201, bill.status);
  je = await capturedJE();
  printJE('vendor bill (expect Dr 2050 5000 / Cr 2000 5000)', je);
  check('P1.4 bill posted Dr GRNI 5000', close(jeNet(je, '2050'), 5000), jeNet(je, '2050'));
  check('P1.4 bill posted Cr A/P 5000', close(jeNet(je, '2000'), -5000), jeNet(je, '2000'));
  check('P1.4 bill touched Inventory NOT AT ALL (no double count)', close(jeNet(je, '1200'), 0, 0.001), jeNet(je, '1200'));
  bs = await assertBooksBalanced('P1.4 after bill');
  check('P1.4 GRNI NETS TO ZERO (delta)', close(bsLine(bs, '2050') - base.grni, 0), bsLine(bs, '2050') - base.grni);
  check('P1.4 A/P +5000', close(bsLine(bs, '2000') - base.ap, 5000), bsLine(bs, '2000') - base.ap);
  check('P1.4 BS Inventory still +5000 exactly', close(bsLine(bs, '1200') - base.inv, 5000), bsLine(bs, '1200') - base.inv);

  // ═════ PHASE 2 — CUSTOMER/VENDOR MASTERS ═════
  console.log('\n— PHASE 2: masters post nothing; balances tie to aging');
  markStep();
  const customer = data(await req('POST', '/customers', { ...A, json: { name: `QA Buyer ${suffix}` } }));
  check('P2 customer created', !!customer?.id);
  je = await capturedJE();
  printJE('create customer', je);
  check('P2 creating customer/vendor posts NOTHING', je.length === 0, je);
  // NOTE: A/P aging reuses the aging-row shape — the vendor's name arrives in
  // the `customerName` field. Cosmetic API quirk, the app's serializer maps it.
  const apAging0 = (await req('GET', '/reports/ap-aging', A)).body;
  const apRow = (apAging0?.rows ?? []).find((x: any) => x.customerName?.includes(`QA Supplier ${suffix}`));
  check('P2 A/P aging shows the vendor bill (5000)', close(Number(apRow?.total ?? 0), 5000), apRow);

  // ═════ PHASE 3a — CREATE & ASSIGN ═════
  console.log('\n— PHASE 3a: assign 20 × A to rider1 (cost 100, sell 150, tax 10%)');
  markStep();
  const mkDelivery = async (items: any[], personnelId: string, extra: Record<string, unknown> = {}) =>
    data(await req('POST', '/deliveries', { ...A, json: { customerId: customer.id, customerName: customer.name, personnelId, items, ...extra } }));
  const d1 = await mkDelivery([{ itemId: idA, itemName: 'QA Widget A', orderedQty: 20, unitPrice: 150, taxRate: 10 }], rider1UserId);
  check('3a delivery created + assigned; ledger echo committed', !!d1?.id && d1?.ledger?.committed === true, d1?.ledger);
  check('3a Sales Order created (non-posting)', !!d1?.ledger?.salesOrderNumber, d1?.ledger?.salesOrderNumber);
  je = await capturedJE();
  printJE('assign (expect Dr 1250 2000 / Cr 1200 2000 at COST)', je);
  check('3a posted Dr GIT 2000 at cost', close(jeNet(je, '1250'), 2000), jeNet(je, '1250'));
  check('3a posted Cr Inventory 2000', close(jeNet(je, '1200'), -2000), jeNet(je, '1200'));
  check('3a NO revenue / NO COGS lines in the JE', jeNet(je, '4000') === 0 && jeNet(je, '5000') === 0, je);
  check('3a on-hand A fell 30 → 10', (await itemQty(idA)) === 10, await itemQty(idA));
  bs = await assertBooksBalanced('3a after assign');
  check('3a GIT delta +2000', close(bsLine(bs, '1250') - base.git, 2000), bsLine(bs, '1250') - base.git);
  let pl = await profitLoss();
  check('3a revenue unchanged (none recognized yet)', close(Number(pl?.revenue ?? 0) - baseRev, 0, 0.005), Number(pl?.revenue ?? 0) - baseRev);
  await assertInventoryTies('3a');

  // ═════ PHASE 3b — OVER-ALLOCATION GUARD ═════
  console.log('\n— PHASE 3b: over-allocation guard (999 units)');
  markStep();
  const huge = await req('POST', '/deliveries', {
    ...A, json: { customerId: customer.id, customerName: customer.name, personnelId: rider1UserId,
      items: [{ itemId: idA, itemName: 'QA Widget A', orderedQty: 999, unitPrice: 150 }] },
  });
  check('3b assigning 999 > on-hand REJECTED (422) with clear error', huge.status === 422, { status: huge.status, err: huge.body?.error ?? huge.body?.message });
  je = await capturedJE();
  check('3b nothing half-posted on rejection', je.length === 0, je);
  check('3b on-hand unchanged (10), never negative', (await itemQty(idA)) === 10);
  await assertBooksBalanced('3b after rejected over-dispatch');

  // ═════ PHASE 3c — RIDER FLOW ═════
  console.log('\n— PHASE 3c: rider isolation, status machine, POD posts nothing');
  const mine1 = data(await req('GET', '/deliveries/my/assigned', R1));
  const mine2 = data(await req('GET', '/deliveries/my/assigned', R2));
  const list1: any[] = Array.isArray(mine1) ? mine1 : mine1?.items ?? [];
  const list2: any[] = Array.isArray(mine2) ? mine2 : mine2?.items ?? [];
  check('3c rider1 sees his delivery', list1.some((x: any) => x.id === d1.id), list1.length);
  check('3c rider2 does NOT see rider1 deliveries', !list2.some((x: any) => x.id === d1.id), list2.length);

  for (const [name, path] of [
    ['trial balance', '/reports/trial-balance?startDate=2026-01-01&endDate=2026-12-31'],
    ['balance sheet', `/reports/balance-sheet?asOfDate=${TODAY}`],
    ['P&L', '/reports/profit-loss?startDate=2026-01-01&endDate=2026-12-31'],
    ['chart of accounts', '/accounts'],
    ['journal entries', '/journal-entries'],
    ['invoices', '/invoices'],
    ['payments', '/payments'],
    ['purchase orders', '/purchase-orders'],
    ['bills', '/bills'],
  ] as const) {
    const r = await req('GET', path, R1);
    check(`3c rider 403 on ${name}`, r.status === 403, r.status);
  }

  // Status machine: illegal skip, legal advance, double-tap idempotent, backward blocked
  const skip = await req('PATCH', `/deliveries/${d1.id}/status`, { ...R1, json: { status: 'arrived' } });
  check('3c skipping pending → arrived REJECTED', skip.status === 400 || skip.status === 422, { status: skip.status, code: skip.body?.error?.code });
  const s1 = await req('PATCH', `/deliveries/${d1.id}/status`, { ...R1, json: { status: 'picked_up' } });
  check('3c pending → picked_up OK', s1.status === 200, s1.status);
  const dbl = await req('PATCH', `/deliveries/${d1.id}/status`, { ...R1, json: { status: 'picked_up' } });
  check('3c double-tap picked_up is idempotent no-op', dbl.status === 200 && data(dbl)?.idempotentReplay === true, data(dbl)?.idempotentReplay);
  const hist1 = data(await req('GET', `/deliveries/${d1.id}/history`, R1));
  const pickedRows = (Array.isArray(hist1) ? hist1 : hist1?.items ?? []).filter((h: any) => h.status === 'picked_up');
  check('3c no duplicate history row from double-tap', pickedRows.length === 1, pickedRows.length);
  await req('PATCH', `/deliveries/${d1.id}/status`, { ...R1, json: { status: 'in_transit' } });
  const back = await req('PATCH', `/deliveries/${d1.id}/status`, { ...R1, json: { status: 'picked_up' } });
  check('3c backward in_transit → picked_up REJECTED', back.status === 400 || back.status === 422, back.status);
  await req('PATCH', `/deliveries/${d1.id}/status`, { ...R1, json: { status: 'arrived' } });

  // POD: mark PAID + upload proof → queues only, posts nothing
  markStep();
  const fd = new FormData();
  fd.append('photo', new Blob([PNG], { type: 'image/png' }), 'bill.png');
  fd.append('signedBy', customer.name);
  fd.append('source', 'camera');
  fd.append('paidStatus', 'paid');
  fd.append('changes', JSON.stringify([{ itemId: idA, itemName: 'QA Widget A', beforeQty: 10, deliveredQty: 20, returnedQty: 0 }]));
  const up = await fetch(`${BASE}/deliveries/${d1.id}/bill-photo`, {
    method: 'POST', headers: { Authorization: `Bearer ${RT1}`, 'x-company-id': cid }, body: fd as any,
  });
  const upBody: any = await up.json().catch(() => null);
  const req1 = upBody?.data?.requestId as string;
  check('3c rider marks PAID + uploads proof → queued for approval', up.status === 201 && !!req1, { status: up.status });
  je = await capturedJE();
  printJE('rider POD (expect nothing)', je);
  check('3c POD posted NOTHING', je.length === 0, je);
  const riderApprove = await req('POST', `/inventory-update-requests/${req1}/approve`, { ...R1, json: {} });
  check('3c rider 403 on approval endpoint', riderApprove.status === 403, riderApprove.status);

  // ═════ PHASE 3d — ADMIN APPROVES PAID ═════
  console.log('\n— PHASE 3d: admin approves the PAID delivery');
  markStep();
  const approve1 = await req('POST', `/inventory-update-requests/${req1}/approve`, { ...A, json: {} });
  check('3d approval succeeded', approve1.status === 200 || approve1.status === 201, approve1.body?.error);
  const led1 = data(approve1)?.ledger;
  check('3d Sales Order → Invoice + Payment (paid)', !!led1?.invoiceId && !!led1?.paymentId, led1);
  je = await capturedJE();
  printJE('approve PAID (expect Dr 1000 3300 / Cr 4000 3000 / Cr 2300 300; Dr 5000 2000 / Cr 1250 2000)', je);
  check('3d Dr Cash 3300', close(jeNet(je, '1000'), 3300), jeNet(je, '1000'));
  check('3d Cr Sales 3000', close(jeNet(je, '4000'), -3000), jeNet(je, '4000'));
  check('3d Cr Tax Payable 300', close(jeNet(je, '2300'), -300), jeNet(je, '2300'));
  check('3d Dr COGS 2000 / Cr GIT 2000', close(jeNet(je, '5000'), 2000) && close(jeNet(je, '1250'), -2000), { cogs: jeNet(je, '5000'), git: jeNet(je, '1250') });
  check('3d GL rows link back (invoice source id = approval invoiceId)',
    je.some(l => l.sourceId === led1?.invoiceId), je.map(l => l.source));
  bs = await assertBooksBalanced('3d after PAID approval');
  check('3d GIT NETS TO ZERO (delta back to baseline)', close(bsLine(bs, '1250') - base.git, 0), bsLine(bs, '1250') - base.git);
  check('3d Cash +3300', close(bsLine(bs, '1000') - base.cash, 3300), bsLine(bs, '1000') - base.cash);
  pl = await profitLoss();
  check('3d P&L: revenue +3000, COGS +2000 (gross profit 1000)',
    close(Number(pl?.revenue) - baseRev, 3000) && close(Number(pl?.cogs) - baseCogs, 2000),
    { dRev: Number(pl?.revenue) - baseRev, dCogs: Number(pl?.cogs) - baseCogs });
  await assertInventoryTies('3d');

  // ═════ PHASE 3h (early) — DOUBLE APPROVE ═════
  const again = await req('POST', `/inventory-update-requests/${req1}/approve`, { ...A, json: {} });
  check('3h approve-twice rejected (409) — no double post', again.status === 409, again.status);
  bs = await balanceSheet();
  check('3h books unchanged after replay (cash still +3300)', close(bsLine(bs, '1000') - base.cash, 3300), bsLine(bs, '1000') - base.cash);

  // ═════ PHASE 3e — NOT-PAID delivery ═════
  console.log('\n— PHASE 3e: NOT-PAID delivery (10 × B, sell 60, tax 10%) via rider2');
  markStep();
  const d2 = await mkDelivery([{ itemId: idB, itemName: 'QA Widget B', orderedQty: 10, unitPrice: 60, taxRate: 10 }], (r2 as any)?.user?.id);
  check('3e assigned to rider2', !!d2?.id && d2?.ledger?.committed === true, d2?.ledger);
  for (const st of ['picked_up', 'in_transit', 'arrived']) {
    await req('PATCH', `/deliveries/${d2.id}/status`, { ...R2, json: { status: st } });
  }
  const fd2 = new FormData();
  fd2.append('photo', new Blob([PNG], { type: 'image/png' }), 'bill.png');
  fd2.append('signedBy', customer.name);
  fd2.append('source', 'camera');
  fd2.append('paidStatus', 'unpaid');
  fd2.append('changes', JSON.stringify([{ itemId: idB, itemName: 'QA Widget B', beforeQty: 40, deliveredQty: 10, returnedQty: 0 }]));
  const up2 = await fetch(`${BASE}/deliveries/${d2.id}/bill-photo`, {
    method: 'POST', headers: { Authorization: `Bearer ${RT2}`, 'x-company-id': cid }, body: fd2 as any,
  });
  const req2 = ((await up2.json().catch(() => null)) as any)?.data?.requestId;
  check('3e rider2 POD (NOT PAID) queued', up2.status === 201 && !!req2, up2.status);
  markStep();
  const approve2 = await req('POST', `/inventory-update-requests/${req2}/approve`, { ...A, json: {} });
  check('3e approval succeeded', approve2.status === 200 || approve2.status === 201, approve2.body?.error);
  const led2 = data(approve2)?.ledger;
  check('3e invoiced on credit — invoice, NO payment', !!led2?.invoiceId && !led2?.paymentId, led2);
  je = await capturedJE();
  printJE('approve NOT PAID (expect Dr 1100 660 / Cr 4000 600 / Cr 2300 60; Dr 5000 400 / Cr 1250 400)', je);
  check('3e Dr A/R 660', close(jeNet(je, '1100'), 660), jeNet(je, '1100'));
  check('3e Cr Sales 600 + Cr Tax 60', close(jeNet(je, '4000'), -600) && close(jeNet(je, '2300'), -60), { s: jeNet(je, '4000'), t: jeNet(je, '2300') });
  check('3e Dr COGS 400 / Cr GIT 400', close(jeNet(je, '5000'), 400) && close(jeNet(je, '1250'), -400), { cogs: jeNet(je, '5000') });
  bs = await assertBooksBalanced('3e after NOT-PAID approval');
  check('3e A/R delta +660 (open invoice)', close(bsLine(bs, '1100') - base.ar, 660), bsLine(bs, '1100') - base.ar);
  check('3e GIT nets to zero again', close(bsLine(bs, '1250') - base.git, 0), bsLine(bs, '1250') - base.git);
  const aging1 = (await req('GET', '/reports/ar-aging', A)).body;
  const agRow = (aging1?.rows ?? []).find((x: any) => x.customerName?.includes(`QA Buyer ${suffix}`));
  check('3e OPEN invoice appears in A/R aging for this customer (660)', close(Number(agRow?.total ?? 0), 660), agRow);

  // ═════ PHASE 3f — LATER PAYMENT ═════
  console.log('\n— PHASE 3f: Receive Payment on the unpaid invoice');
  markStep();
  const revBeforePay = Number((await profitLoss())?.revenue ?? 0);
  const payRes = await req('POST', '/payments', {
    ...A, json: { customerId: customer.id, paymentDate: TODAY, paymentMethod: 'cash', amount: '660.00', applications: [{ invoiceId: led2.invoiceId, amount: '660.00' }] },
  });
  check('3f payment accepted', payRes.status === 200 || payRes.status === 201, payRes.body?.error);
  je = await capturedJE();
  printJE('receive payment (expect Dr 1000 660 / Cr 1100 660)', je);
  check('3f Dr Cash 660 / Cr A/R 660', close(jeNet(je, '1000'), 660) && close(jeNet(je, '1100'), -660), { c: jeNet(je, '1000'), ar: jeNet(je, '1100') });
  const inv2 = data(await req('GET', `/invoices/${led2.invoiceId}`, A));
  check('3f invoice now Paid', (inv2?.status ?? inv2?.invoice?.status) === 'paid', inv2?.status);
  const aging2 = (await req('GET', '/reports/ar-aging', A)).body;
  const agRow2 = (aging2?.rows ?? []).find((x: any) => x.customerName?.includes(`QA Buyer ${suffix}`));
  check('3f A/R aging drops it', close(Number(agRow2?.total ?? 0), 0), agRow2);
  check('3f P&L UNCHANGED by the payment', close(Number((await profitLoss())?.revenue ?? 0), revBeforePay, 0.005));
  bs = await assertBooksBalanced('3f after payment');
  check('3f A/R back to baseline', close(bsLine(bs, '1100') - base.ar, 0), bsLine(bs, '1100') - base.ar);

  // ═════ PHASE 3g — RETURNED delivery ═════
  console.log('\n— PHASE 3g: returned delivery (5 × A) — reversal + restock');
  const qtyABeforeReturnCycle = await itemQty(idA);
  const revBeforeReturn = Number((await profitLoss())?.revenue ?? 0);
  const d3 = await mkDelivery([{ itemId: idA, itemName: 'QA Widget A', orderedQty: 5, unitPrice: 150, taxRate: 10 }], rider1UserId);
  check('3g assigned (5 × A, GIT +500)', d3?.ledger?.committed === true, d3?.ledger);
  await req('PATCH', `/deliveries/${d3.id}/status`, { ...R1, json: { status: 'picked_up' } });
  await req('PATCH', `/deliveries/${d3.id}/status`, { ...R1, json: { status: 'in_transit' } });
  markStep();
  const ret = await req('PATCH', `/deliveries/${d3.id}/status`, { ...R1, json: { status: 'returned', notes: 'Customer refused' } });
  check('3g rider marks returned', ret.status === 200, ret.status);
  je = await capturedJE();
  printJE('return (expect Dr 1200 500 / Cr 1250 500)', je);
  check('3g reversal Dr Inventory 500 / Cr GIT 500', close(jeNet(je, '1200'), 500) && close(jeNet(je, '1250'), -500), { inv: jeNet(je, '1200'), git: jeNet(je, '1250') });
  check('3g NO revenue, NO COGS on return', jeNet(je, '4000') === 0 && jeNet(je, '5000') === 0, je);
  check('3g stock restored', (await itemQty(idA)) === qtyABeforeReturnCycle, { before: qtyABeforeReturnCycle, after: await itemQty(idA) });
  check('3g revenue unchanged', close(Number((await profitLoss())?.revenue ?? 0), revBeforeReturn, 0.005));
  bs = await assertBooksBalanced('3g after return');
  check('3g GIT nets to zero', close(bsLine(bs, '1250') - base.git, 0), bsLine(bs, '1250') - base.git);
  await assertInventoryTies('3g');

  // ═════ PHASE 4 — REPORTS TIE-OUT ═════
  console.log('\n— PHASE 4: full reports tie-out');
  const tb = await trialBalance();
  check('P4 Trial Balance: debits = credits', tb?.isBalanced === true && close(Number(tb?.totalDebits), Number(tb?.totalCredits), 0.005), { dr: tb?.totalDebits, cr: tb?.totalCredits });
  pl = await profitLoss();
  check('P4 P&L run deltas: Sales +3600, COGS +2400, GP +1200',
    close(Number(pl?.revenue) - baseRev, 3600) && close(Number(pl?.cogs) - baseCogs, 2400),
    { dRev: Number(pl?.revenue) - baseRev, dCogs: Number(pl?.cogs) - baseCogs });
  bs = await assertBooksBalanced('P4 final');
  await assertInventoryTies('P4 final');
  check('P4 GRNI delta 0 after full purchase cycle', close(bsLine(bs, '2050') - base.grni, 0), bsLine(bs, '2050') - base.grni);
  check('P4 GIT delta 0 — all this run’s deliveries completed', close(bsLine(bs, '1250') - base.git, 0), bsLine(bs, '1250') - base.git);
  check('P4 inventory never negative (A/B on-hand ≥ 0)', (await itemQty(idA)) >= 0 && (await itemQty(idB)) >= 0);
  check('P4 net inventory delta ties: +5000 − 2000 − 400 + 0(returned back) = +2600',
    close(bsLine(bs, '1200') - base.inv, 2600), bsLine(bs, '1200') - base.inv);
  // GL rows link back to sources for the whole run
  const orphan = await pg.query(
    `SELECT COUNT(*)::int AS n FROM general_ledger WHERE company_id = $1 AND (source_type IS NULL OR source_id IS NULL)`, [cid]);
  check('P4 every GL row carries source_type + source_id (links back)', orphan.rows[0].n === 0, orphan.rows[0]);

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fails.length) { console.log('Failed:'); fails.forEach(f => console.log(`  - ${f}`)); }
  await pg.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
