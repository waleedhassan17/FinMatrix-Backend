/**
 * phase4.md CHUNK 2 — accounting-core acceptance test (HTTP, end-to-end).
 *
 * One long worked example on a fresh company. After EVERY posting operation
 * it asserts the two prime-directive invariants:
 *   • Trial Balance: total debits === total credits (to the paisa)
 *   • Balance Sheet: Assets === Liabilities + Equity
 * plus the cross-report ties at the checkpoints phase4 Phase C requires:
 *   • Balance Sheet Inventory (GL 1200) === Inventory Valuation total
 *   • GL 1100 === Σ open invoice balances === A/R Aging total
 *   • GL 2000 === Σ open bill balances === A/P Aging total
 *   • P&L net profit === Balance Sheet current-period equity line
 * and the chunk-2 features:
 *   • weighted-average cost on PO receipts (10 @ 90 + 10 @ 110 → avg 100)
 *   • GRNI parks at receipt and nets to exactly 0 after billing
 *   • input tax → Sales Tax Recoverable 1300 when the company is registered
 *   • delivery approval commits stock to the ledger (Dr COGS / Cr Inventory)
 *     and undo posts the exact reversal
 *   • bank reconciliation drives the difference to 0, finalizes, locks
 *     (only the latest can be undone) and posts NO journal entries
 *
 * Run against a booted server:
 *   BASE_URL=http://localhost:3001/api/v1 \
 *   PG_URL=postgres://user:pass@localhost:5432/finmatrix_qa \
 *   node -r ts-node/register -r tsconfig-paths/register test/chunk2.acceptance.ts
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

  console.log(`\n=== phase4 Chunk 2 accounting acceptance @ ${BASE} ===\n`);

  // ── Setup ────────────────────────────────────────────────────────────────
  console.log('— Setup (fresh tax-registered company)');
  const superLogin = await req('POST', '/auth/signin', { json: { email: SUPER_EMAIL, password: SUPER_PASSWORD } });
  const superToken = data(superLogin)?.tokens?.accessToken;
  check('super-admin signs in', !!superToken, superLogin.status);

  const email = `qa_acct_${Date.now()}@qa.local`;
  const signup = await req('POST', '/auth/signup', {
    json: { email, password: 'Qa@12345', displayName: 'QA Accountant', phone: '+92-300-1234567', role: 'admin' },
  });
  const token0 = data(signup)?.tokens?.accessToken;
  const userId = data(signup)?.user?.id;
  const createCo = await req('POST', '/companies', { token: token0, json: { name: `QA Books ${Date.now()}`, industry: 'Retail' } });
  const cid = data(createCo)?.id;
  await req('POST', `/companies/${cid}/submit`, { token: token0, companyId: cid });
  await req('PATCH', `/admin/companies/${cid}/approve`, { token: superToken });
  await pg.query(`UPDATE users SET is_email_verified = true WHERE id = $1`, [userId]);
  await pg.query(`UPDATE companies SET sales_tax_registered = true, subscription_plan = 'standard' WHERE id = $1`, [cid]);
  const relogin = await signin(email, 'Qa@12345');
  const T = data(relogin)?.tokens?.accessToken;
  check('admin ready (tax-registered company)', !!T && !!cid);
  const A = { token: T, companyId: cid };

  // ── Report helpers (reports return RAW json, no envelope) ────────────────
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
    return { tb, bs };
  };
  const assertInventoryTies = async (label: string) => {
    const bs = await balanceSheet();
    const val = await valuation();
    check(`${label} — BS Inventory (1200) = Valuation total`,
      close(bsLine(bs, '1200'), Number(val?.totalValue), 0.01),
      { gl1200: bsLine(bs, '1200'), valuation: val?.totalValue });
  };

  // ── Masters ──────────────────────────────────────────────────────────────
  const customer = data(await req('POST', '/customers', { ...A, json: { name: 'Acct Customer' } }));
  const vendor = data(await req('POST', '/vendors', { ...A, json: { companyName: 'Acct Vendor' } }));
  const item = data(await req('POST', '/inventory/items', { ...A, json: { sku: `WID-${Date.now()}`, name: 'Widget', unitCost: '0', sellingPrice: '150' } }));
  const itemId = item?.id ?? item?.item?.id;
  check('masters created', !!customer?.id && !!vendor?.id && !!itemId);
  await assertBooksBalanced('empty books');

  // ── 1. Opening balance → OBE offset ─────────────────────────────────────
  console.log('\n— Opening balances (OBE 3900 offset)');
  const petty = await req('POST', '/accounts', {
    ...A, json: { accountNumber: '1005', name: 'Petty Cash', type: 'asset', subType: 'Cash', openingBalance: '5000' },
  });
  check('opening-balance account created', petty.status === 201 || petty.status === 200, petty.body);
  const { bs: bs1 } = await assertBooksBalanced('after opening balance');
  check('OBE 3900 carries the 5,000 offset', close(bsLine(bs1, '3900'), 5000), bsLine(bs1, '3900'));

  // ── 2. Weighted-average receipts (10 @ 90, then 10 @ 110 → avg 100) ─────
  console.log('\n— PO receipts + weighted-average cost + GRNI');
  const mkPo = async (unitCost: string) => {
    const po = data(await req('POST', '/purchase-orders', {
      ...A, json: { vendorId: vendor.id, orderDate: TODAY, lines: [{ description: 'Widgets', orderedQty: '10', unitCost, itemId }] },
    }));
    const lineId = po?.lines?.[0]?.id;
    await req('POST', `/purchase-orders/${po.id}/receive`, { ...A, json: { lines: [{ lineId, receivedQty: '10' }] } });
    return po;
  };
  const po1 = await mkPo('90');
  const itemAfter1 = data(await req('GET', `/inventory/items/${itemId}`, A));
  check('receipt 1: avg cost 90.0000', close(Number(itemAfter1?.unitCost), 90, 0.0001), itemAfter1?.unitCost);
  const po2 = await mkPo('110');
  const itemAfter2 = data(await req('GET', `/inventory/items/${itemId}`, A));
  check('receipt 2: weighted avg = (10×90 + 10×110)/20 = 100', close(Number(itemAfter2?.unitCost), 100, 0.0001), itemAfter2?.unitCost);
  await assertBooksBalanced('after receipts');
  await assertInventoryTies('after receipts');
  const bsRec = await balanceSheet();
  check('GRNI 2050 parked at 2,000 (900 + 1,100)', close(bsLine(bsRec, '2050'), 2000), bsLine(bsRec, '2050'));

  // ── 3. Bills from POs → GRNI nets to exactly 0 ──────────────────────────
  const bill1 = data(await req('POST', `/purchase-orders/${po1.id}/create-bill`, { ...A, json: { billNumber: `B-${Date.now()}-1`, billDate: TODAY, dueDate: TODAY } }));
  const bill2 = data(await req('POST', `/purchase-orders/${po2.id}/create-bill`, { ...A, json: { billNumber: `B-${Date.now()}-2`, billDate: TODAY, dueDate: TODAY } }));
  const bill1Id = bill1?.billId ?? bill1?.id;
  const bill2Id = bill2?.billId ?? bill2?.id;
  check('bills created from POs', !!bill1Id && !!bill2Id, { bill1, bill2 });
  const { bs: bsBills } = await assertBooksBalanced('after PO bills');
  check('GRNI nets to exactly 0 after billing', close(bsLine(bsBills, '2050'), 0, 0.005), bsLine(bsBills, '2050'));
  check('AP 2000 owes the two bills (2,000)', close(bsLine(bsBills, '2000'), 2000), bsLine(bsBills, '2000'));
  await assertInventoryTies('after PO bills (inventory rose exactly once)');

  // ── 4. Invoice: 5 widgets @ 150, 10% tax → revenue + tax + COGS ─────────
  console.log('\n— Invoice (revenue + tax + COGS at avg cost)');
  const inv = data(await req('POST', '/invoices', {
    ...A,
    json: {
      customerId: customer.id, invoiceDate: TODAY, dueDate: TODAY, status: 'sent',
      lines: [{ description: 'Widget', quantity: '5', unitPrice: '150', taxRate: '10', itemId }],
    },
  }));
  check('invoice posted (total 825 = 750 + 75 tax)', close(Number(inv?.total), 825), inv?.total);
  const { bs: bsInv } = await assertBooksBalanced('after invoice');
  check('AR 1100 = 825', close(bsLine(bsInv, '1100'), 825), bsLine(bsInv, '1100'));
  check('Tax Payable 2300 = 75', close(bsLine(bsInv, '2300'), 75), bsLine(bsInv, '2300'));
  await assertInventoryTies('after invoice (COGS relieved 5 × 100)');

  // ── 5. Payments: partial then final; AR ties to aging ───────────────────
  console.log('\n— Receive payment (partial + final)');
  await req('POST', '/payments', { ...A, json: { customerId: customer.id, paymentDate: TODAY, paymentMethod: 'cash', amount: '500.00', applications: [{ invoiceId: inv.id, amount: '500.00' }] } });
  await req('POST', '/payments', { ...A, json: { customerId: customer.id, paymentDate: TODAY, paymentMethod: 'cash', amount: '325.00', applications: [{ invoiceId: inv.id, amount: '325.00' }] } });
  const { bs: bsPay } = await assertBooksBalanced('after payments');
  check('AR 1100 back to 0 after full payment', close(bsLine(bsPay, '1100'), 0, 0.005), bsLine(bsPay, '1100'));

  // ── 6. Credit memo with return → restock + refund ───────────────────────
  console.log('\n— Credit memo (return 1 widget) + cash refund');
  const cm = data(await req('POST', '/credit-memos', {
    ...A,
    json: { customerId: customer.id, date: TODAY, originalInvoiceId: inv.id, lines: [{ description: 'Widget return', quantity: '1', unitPrice: '150', taxRate: '10', itemId }] },
  }));
  check('credit memo posted', !!cm?.id, cm);
  const refund = await req('POST', `/credit-memos/${cm.id}/refund`, { ...A, json: {} });
  check('cash refund posted', refund.status === 200, refund.status);
  await assertBooksBalanced('after credit memo + refund');
  await assertInventoryTies('after return restock (qty 16 × 100)');

  // ── 7. Expense bill with input tax → recoverable 1300 ───────────────────
  console.log('\n— Expense bill (tax-registered → input tax to 1300)');
  const accountsList = data(await req('GET', '/accounts?search=6000', A));
  const rentAcct = (accountsList?.accounts ?? []).find((a: any) => a.accountNumber === '6000');
  const expBill = data(await req('POST', '/bills', {
    ...A,
    json: { vendorId: vendor.id, billDate: TODAY, dueDate: TODAY, lines: [{ description: 'Rent', amount: '200', taxRate: '10', accountId: rentAcct?.id }] },
  }));
  check('expense bill posted (220 gross)', close(Number(expBill?.total), 220), expBill?.total);
  const { bs: bsExp } = await assertBooksBalanced('after expense bill');
  check('input tax parked on Sales Tax Recoverable 1300 (20)', close(bsLine(bsExp, '1300'), 20), bsLine(bsExp, '1300'));

  // ── 8. Pay a bill ────────────────────────────────────────────────────────
  const cashForPay = (data(await req('GET', '/accounts?search=1000', A))?.accounts ?? []).find((a: any) => a.accountNumber === '1000');
  const payBills = await req('POST', '/bills/pay', {
    ...A,
    json: {
      vendorId: vendor.id, paymentDate: TODAY, paymentMethod: 'cash', bankAccountId: cashForPay?.id,
      applications: [{ billId: bill1Id, amount: '900.00' }],
    },
  });
  check('bill payment posted', payBills.status === 201 || payBills.status === 200, payBills.body);
  await assertBooksBalanced('after bill payment');

  // ── 9. Inventory adjustment (−2) ─────────────────────────────────────────
  console.log('\n— Inventory adjustment');
  const adj = await req('POST', `/inventory/items/${itemId}/adjust`, { ...A, json: { itemId, newQty: '14', reason: 'damage' } });
  check('adjustment posted', adj.status === 201 || adj.status === 200, adj.body);
  await assertBooksBalanced('after adjustment');
  await assertInventoryTies('after adjustment (qty 14 × 100)');

  // ── 10. Tax payment (against output tax net of memo) ────────────────────
  const rate = data(await req('POST', '/taxes/rates', { ...A, json: { name: 'GST', rate: '10', taxType: 'sales' } }));
  const taxPay = await req('POST', '/taxes/payments', { ...A, json: { taxRateId: rate?.id, period: '2026-H1', amount: '50', paymentDate: TODAY } });
  check('tax payment posted', taxPay.status === 201 || taxPay.status === 200, taxPay.body);
  await assertBooksBalanced('after tax payment');

  // ── 11. Delivery approval commits stock to the ledger ────────────────────
  console.log('\n— Delivery approval → ledger commit (the chunk-1 CHUNK2 marker)');
  const rider = data(await req('POST', '/delivery-personnel', {
    ...A, json: { email: `acct_rider_${Date.now()}@qa.local`, password: 'Rider@123', name: 'Acct Rider' },
  }));
  const riderLogin = await signin(rider?.email, 'Rider@123');
  const RT = data(riderLogin)?.tokens?.accessToken;
  check('rider ready', !!rider?.userId && !!RT);
  const delivery = data(await req('POST', '/deliveries', {
    ...A, json: { customerId: customer.id, customerName: 'Acct Customer', personnelId: rider.userId, items: [{ itemId, itemName: 'Widget', orderedQty: 2, unitPrice: 150 }] },
  }));
  for (const st of ['picked_up', 'in_transit', 'arrived']) {
    await req('PATCH', `/deliveries/${delivery.id}/status`, { token: RT, companyId: cid, json: { status: st } });
  }
  const fd = new FormData();
  fd.append('photo', new Blob([PNG], { type: 'image/png' }), 'bill.png');
  fd.append('signedBy', 'Acct Customer');
  fd.append('source', 'camera');
  fd.append('changes', JSON.stringify([{ itemId, itemName: 'Widget', beforeQty: 14, deliveredQty: 2, returnedQty: 0 }]));
  const up = await fetch(`${BASE}/deliveries/${delivery.id}/bill-photo`, {
    method: 'POST', headers: { Authorization: `Bearer ${RT}`, 'x-company-id': cid }, body: fd as any,
  });
  const upBody: any = await up.json().catch(() => null);
  const reqId = upBody?.data?.requestId;
  check('POD submitted', up.status === 201 && !!reqId, upBody);

  const invBefore = bsLine(await balanceSheet(), '1200');
  const approve = await req('POST', `/inventory-update-requests/${reqId}/approve`, { ...A, json: {} });
  check('approval succeeded', approve.status === 200 || approve.status === 201, approve.body);
  const bsApproved = await balanceSheet();
  check('approval posted Dr COGS / Cr Inventory (1200 −200 = 2 × avg 100)',
    close(invBefore - bsLine(bsApproved, '1200'), 200, 0.01),
    { before: invBefore, after: bsLine(bsApproved, '1200') });
  await assertBooksBalanced('after delivery approval');
  await assertInventoryTies('after delivery approval (qty 12 × 100)');
  const jeLink = await pg.query(`SELECT journal_entry_id FROM inventory_update_requests WHERE id = $1`, [reqId]);
  check('approval linked to its journal entry', !!jeLink.rows[0]?.journal_entry_id, jeLink.rows[0]);

  const undo = await req('POST', `/inventory-update-requests/${reqId}/undo`, { ...A, json: {} });
  check('undo succeeded', undo.status === 200 || undo.status === 201, undo.body);
  const bsUndone = await balanceSheet();
  check('undo posted the exact reversal (1200 restored)', close(bsLine(bsUndone, '1200'), invBefore, 0.01),
    { restored: bsLine(bsUndone, '1200'), expected: invBefore });
  await assertBooksBalanced('after approval undo');
  await assertInventoryTies('after approval undo (qty 14 × 100)');

  // ── 12. Cross-report invariants ──────────────────────────────────────────
  console.log('\n— Cross-report invariants');
  const bsX = await balanceSheet();
  const arRows = await pg.query(`SELECT COALESCE(SUM(balance::numeric),0) AS s FROM invoices WHERE company_id=$1 AND status NOT IN ('paid','void','draft')`, [cid]);
  const arAging = (await req('GET', '/reports/ar-aging', A)).body;
  const arAgingTotal = (arAging?.rows ?? arAging ?? []).reduce?.((a: number, x: any) => a + Number(x.total ?? 0), 0) ?? 0;
  check('GL 1100 = Σ open invoices = A/R aging total',
    close(bsLine(bsX, '1100'), Number(arRows.rows[0].s), 0.01) && close(Number(arRows.rows[0].s), arAgingTotal, 0.01),
    { gl: bsLine(bsX, '1100'), docs: arRows.rows[0].s, aging: arAgingTotal });
  const apRows = await pg.query(`SELECT COALESCE(SUM(balance::numeric),0) AS s FROM bills WHERE company_id=$1 AND status NOT IN ('paid','void','draft')`, [cid]);
  const apAging = (await req('GET', '/reports/ap-aging', A)).body;
  const apAgingTotal = (apAging?.rows ?? apAging ?? []).reduce?.((a: number, x: any) => a + Number(x.total ?? 0), 0) ?? 0;
  check('GL 2000 = Σ open bills = A/P aging total',
    close(bsLine(bsX, '2000'), Number(apRows.rows[0].s), 0.01) && close(Number(apRows.rows[0].s), apAgingTotal, 0.01),
    { gl: bsLine(bsX, '2000'), docs: apRows.rows[0].s, aging: apAgingTotal });
  const pl = (await req('GET', `/reports/profit-loss?startDate=1970-01-01&endDate=2999-12-31`, A)).body;
  const netIncomeLine = (bsX?.equity ?? []).find((x: any) => x.accountName?.includes('Net Income'))?.amount ?? 0;
  check('P&L net profit rolls into equity on the Balance Sheet',
    close(Number(pl?.netProfit ?? pl?.netIncome ?? pl?.net), Number(netIncomeLine), 0.01),
    { pl: pl?.netProfit ?? pl?.netIncome ?? pl?.net, equityLine: netIncomeLine });

  // ── 13. Bank reconciliation: difference → 0, finalize, lock, no JEs ─────
  console.log('\n— Bank reconciliation');
  const cashAcct = (data(await req('GET', '/accounts?search=1000', A))?.accounts ?? []).find((a: any) => a.accountNumber === '1000');
  const unrec = data(await req('GET', `/reconciliations/unreconciled?accountId=${cashAcct.id}&statementDate=${TODAY}`, A));
  const entries: any[] = unrec?.entries ?? unrec?.data ?? [];
  check('unreconciled cash entries listed', entries.length > 0, { count: entries.length });
  const clearedBalance = entries.reduce((a, e) => a + Number(e.debit ?? 0) - Number(e.credit ?? 0), Number(unrec?.beginningBalance ?? 0));
  const jeCountBefore = await pg.query(`SELECT COUNT(*)::int AS c FROM journal_entries WHERE company_id=$1`, [cid]);

  const badRec = await req('POST', '/reconciliations', {
    ...A, json: { accountId: cashAcct.id, statementDate: TODAY, statementEndingBalance: (clearedBalance + 99).toFixed(2), clearedEntryIds: entries.map(e => e.id) },
  });
  check('out-of-balance reconciliation rejected', badRec.status === 400, badRec.status);

  const rec1 = await req('POST', '/reconciliations', {
    ...A, json: { accountId: cashAcct.id, statementDate: TODAY, statementEndingBalance: clearedBalance.toFixed(2), clearedEntryIds: entries.map(e => e.id) },
  });
  check('reconciliation finalized at difference 0', rec1.status === 201 || rec1.status === 200, rec1.body);
  const rec1Id = data(rec1)?.id;
  const jeCountAfter = await pg.query(`SELECT COUNT(*)::int AS c FROM journal_entries WHERE company_id=$1`, [cid]);
  check('reconciliation posted NO journal entries', jeCountBefore.rows[0].c === jeCountAfter.rows[0].c,
    { before: jeCountBefore.rows[0].c, after: jeCountAfter.rows[0].c });
  const stamped = await pg.query(`SELECT COUNT(*)::int AS c FROM general_ledger WHERE reconciliation_id = $1 AND cleared = true`, [rec1Id]);
  check('cleared rows stamped reconciled', stamped.rows[0].c === entries.length, stamped.rows[0]);

  const rec2 = await req('POST', '/reconciliations', {
    ...A, json: { accountId: cashAcct.id, statementDate: TODAY, statementEndingBalance: clearedBalance.toFixed(2), clearedEntryIds: [] },
  });
  const rec2Id = data(rec2)?.id;
  check('second (empty) reconciliation finalized', !!rec2Id, rec2.body);
  const undoOld = await req('DELETE', `/reconciliations/${rec1Id}`, A);
  check('undoing a NON-latest reconciliation is blocked (locked period)', undoOld.status === 400, undoOld.status);
  const undoNew = await req('DELETE', `/reconciliations/${rec2Id}`, A);
  check('undoing the latest reconciliation allowed + audited', undoNew.status === 200, undoNew.status);
  const recAudit = await pg.query(`SELECT COUNT(*)::int AS c FROM operational_audit_events WHERE company_id=$1 AND action='reconciliation_undone'`, [cid]);
  check('reconciliation undo recorded in the audit trail', recAudit.rows[0].c === 1, recAudit.rows[0]);
  await assertBooksBalanced('after reconciliation (marks only)');

  // ── Final: the long chain leaves TB off by EXACTLY 0 ─────────────────────
  console.log('\n— Final invariants');
  const tbFinal = await trialBalance();
  check('FINAL: Trial Balance off by exactly 0',
    close(Number(tbFinal?.totalDebits), Number(tbFinal?.totalCredits), 0.005),
    { dr: tbFinal?.totalDebits, cr: tbFinal?.totalCredits });
  await assertInventoryTies('FINAL');

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fails.length) { console.log('Failed:'); fails.forEach(f => console.log(`  - ${f}`)); }
  await pg.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
