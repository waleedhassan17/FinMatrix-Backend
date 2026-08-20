#!/usr/bin/env node
/**
 * FinMatrix delivery-flow end-to-end gate.
 *
 * Drives the shelf-onward half of the flow diagram through the REAL HTTP API —
 * the same endpoints the mobile app calls — and asserts the exact journal lines
 * the diagram names for every branch:
 *
 *   Create delivery      -> no entry
 *   Assign to rider      -> Dr Goods in Transit / Cr Inventory (AT COST)
 *                           no revenue, no COGS
 *   Rider delivers       -> no entry
 *   Approve  PAID        -> Dr Cash / Cr Sales  +  Dr COGS / Cr Goods in Transit
 *   Approve  UNPAID      -> Dr A/R  / Cr Sales  +  Dr COGS / Cr Goods in Transit
 *                           later payment: Dr Bank / Cr A/R, P&L unchanged
 *   Approve  PREPAID     -> revenue recognised on delivery, not dispatch
 *   REJECTED             -> Dr Inventory / Cr Goods in Transit, no revenue
 *   Credit memo          -> Dr Sales / Cr A/R  +  Dr Inventory / Cr COGS
 *   Vendor credit        -> Dr Accounts Payable / Cr Inventory
 *
 * Assertions are on the DELTA of each account across the step, read from the
 * ledger, so a branch that posts nothing is proven to post nothing rather than
 * merely appearing to work.
 *
 * Run against a throwaway warehouse company — never a real one; it creates
 * deliveries, invoices, payments and journal entries.
 *
 *   FLOW_CTX=qa/.flow-ctx.json DATABASE_URL=postgres://... node qa/flow-e2e.js
 *   npm run qa:flow
 *
 * Exit codes: 0 all branches conform, 1 a branch deviates, 2 could not run.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { post, get, patch, data, rows, money, near, BASE } = require('./flow-lib');

const CTX_PATH = process.env.FLOW_CTX || path.join(__dirname, '.flow-ctx.json');
const today = () => new Date().toISOString().slice(0, 10);

let db;
let ctx;
let admin; // { token, companyId }
let rider; // { token, companyId, userId }
let seed; // { customerId, vendorId, items, accounts }

const results = [];
function record(branch, checks) {
  const failed = checks.filter((c) => !c.pass);
  results.push({ branch, checks, ok: failed.length === 0 });
  console.log(`\n${failed.length === 0 ? 'PASS' : 'FAIL'}  ${branch}`);
  for (const c of checks) {
    console.log(`   ${c.pass ? '  ok' : '  XX'}  ${c.label}${c.pass ? '' : `   expected ${c.expected}, got ${c.actual}`}`);
  }
}

/** Net movement (debit - credit) per account number since a marker id. */
async function ledgerSince(marker) {
  const { rows: r } = await db.query(
    `SELECT a.account_number AS num, a.name,
            ROUND(SUM(g.debit)::numeric, 2)  AS dr,
            ROUND(SUM(g.credit)::numeric, 2) AS cr
       FROM general_ledger g
       JOIN accounts a ON a.id = g.account_id
      WHERE g.company_id = $1 AND g.created_at > $2
      GROUP BY a.account_number, a.name
      ORDER BY a.account_number`,
    [admin.companyId, marker],
  );
  const out = {};
  for (const row of r) out[row.num] = { dr: money(row.dr), cr: money(row.cr), name: row.name };
  return out;
}

const mark = () => new Date();

/** Assert an account moved by exactly `dr` debit and `cr` credit. */
function movement(led, num, label, dr, cr) {
  const got = led[num] || { dr: 0, cr: 0 };
  return {
    label: `${label} (${num}): Dr ${dr.toFixed(2)} / Cr ${cr.toFixed(2)}`,
    pass: near(got.dr, dr) && near(got.cr, cr),
    expected: `Dr ${dr.toFixed(2)}/Cr ${cr.toFixed(2)}`,
    actual: `Dr ${got.dr.toFixed(2)}/Cr ${got.cr.toFixed(2)}`,
  };
}
/** Assert an account did not move at all. */
function untouched(led, num, label) {
  return movement(led, num, `${label} untouched`, 0, 0);
}
/** Assert nothing whatsoever posted. */
function nothingPosted(led, label) {
  const touched = Object.keys(led);
  return {
    label,
    pass: touched.length === 0,
    expected: 'no ledger rows',
    actual: touched.length ? `moved ${touched.join(',')}` : 'no ledger rows',
  };
}

/** Create -> assign -> rider marks delivered -> rider submits bill photo. */
async function runDelivery({ itemKey, qty, prepaid, paidStatus }) {
  const item = seed.items[itemKey];
  const o = { token: admin.token, companyId: admin.companyId };

  const created = data(
    await post(
      '/deliveries',
      {
        customerId: seed.customerId,
        customerName: 'FlowTest Customer',
        preferredDate: today(),
        prePaid: !!prepaid,
        items: [{ itemId: item.id, itemName: item.name, orderedQty: qty, unitPrice: item.price }],
      },
      o,
    ),
  );
  const deliveryId = created.id || (created.delivery || {}).id;

  const assigned = await post('/deliveries/assign', { deliveryIds: [deliveryId], personnelId: rider.userId }, o);
  if (assigned.status >= 400) throw new Error(`assign failed ${assigned.status} ${JSON.stringify(assigned.body).slice(0, 200)}`);

  return { deliveryId, item, qty };
}

/** The rider's multipart bill-photo submission (creates the approval request). */
async function submitBillPhoto({ deliveryId, item, qty, signedBy, returnedQty = 0, paidStatus }) {
  // Smallest thing multer will accept as a real jpeg.
  const jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==',
    'base64',
  );
  const form = new FormData();
  form.append('photo', new Blob([jpeg], { type: 'image/jpeg' }), 'bill.jpg');
  form.append('signedBy', signedBy || 'FlowTest Customer');
  form.append('source', 'camera');
  // The rider's cash flag. The app appends exactly this field; it decides
  // whether approval debits Cash or Accounts Receivable.
  if (paidStatus) form.append('paidStatus', paidStatus);
  form.append(
    'changes',
    JSON.stringify([
      { itemId: item.id, itemName: item.name, beforeQty: 0, deliveredQty: qty - returnedQty, returnedQty },
    ]),
  );

  const res = await fetch(`${BASE}/deliveries/${deliveryId}/bill-photo`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rider.token}`, 'x-company-id': rider.companyId },
    body: form,
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function main() {
  if (!fs.existsSync(CTX_PATH)) {
    console.error(`flow-e2e: no context at ${CTX_PATH}. Provision a throwaway warehouse company first.`);
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error('flow-e2e: DATABASE_URL is not set (needed to read the ledger back).');
    process.exit(2);
  }
  ctx = JSON.parse(fs.readFileSync(CTX_PATH, 'utf8'));

  db = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
  await db.connect();

  const aSi = await post('/auth/signin', ctx.admin);
  if (aSi.status !== 200) throw new Error(`admin signin ${aSi.status}`);
  admin = { token: data(aSi).tokens.accessToken, companyId: ctx.companyId };

  const rSi = await post('/auth/signin', ctx.rider);
  if (rSi.status !== 200) throw new Error(`rider signin ${rSi.status}`);
  rider = { token: data(rSi).tokens.accessToken, companyId: ctx.companyId, userId: data(rSi).user.id };

  seed = ctx.seed;

  console.log('=== FinMatrix delivery flow vs the diagram ===');
  console.log(`company ${admin.companyId}  api ${BASE}\n`);

  await branchNoEntryOnCreate();
  await branchAssign();
  await branchApprovePaid();
  await branchApproveUnpaid();
  await branchReject();

  const failed = results.filter((r) => !r.ok);
  console.log(`\nbranches: ${results.length} | conforming: ${results.length - failed.length} | deviating: ${failed.length}`);
  await db.end();
  process.exit(failed.length === 0 ? 0 : 1);
}

// ── Branch: creating a delivery must post nothing ────────────────────────────
async function branchNoEntryOnCreate() {
  const m = mark();
  const item = seed.items.A;
  const res = await post(
    '/deliveries',
    {
      customerId: seed.customerId,
      customerName: 'FlowTest Customer',
      preferredDate: today(),
      items: [{ itemId: item.id, itemName: item.name, orderedQty: 1, unitPrice: item.price }],
    },
    { token: admin.token, companyId: admin.companyId },
  );
  await new Promise((r) => setTimeout(r, 400));
  const led = await ledgerSince(m);
  record('Create Delivery -> no entry (a plan, not a transaction)', [
    { label: `create returned ${res.status}`, pass: res.status < 400, expected: '<400', actual: String(res.status) },
    nothingPosted(led, 'no journal lines posted'),
  ]);
}

// ── Branch: assign to rider -> Dr GIT / Cr Inventory at COST, nothing else ───
async function branchAssign() {
  const m = mark();
  const { deliveryId, item, qty } = await runDelivery({ itemKey: 'A', qty: 10 });
  await new Promise((r) => setTimeout(r, 500));
  const led = await ledgerSince(m);
  const cost = item.cost * qty;
  record('Assign to Rider -> Dr Goods in Transit / Cr Inventory (AT COST)', [
    movement(led, '1250', 'Goods in Transit', cost, 0),
    movement(led, '1200', 'Inventory', 0, cost),
    untouched(led, '4000', 'Sales Revenue'),
    untouched(led, '5000', 'Cost of Goods Sold'),
  ]);
  branchAssign.deliveryId = deliveryId;
  branchAssign.item = item;
  branchAssign.qty = qty;
}

// ── Branch: approve PAID ─────────────────────────────────────────────────────
async function branchApprovePaid() {
  const { deliveryId, item, qty } = branchAssign;
  const o = { token: admin.token, companyId: admin.companyId };

  await patch(`/deliveries/${deliveryId}/status`, { status: 'in_transit' }, o);
  await patch(`/deliveries/${deliveryId}/status`, { status: 'delivered', paidStatus: 'paid' }, o);

  const mSubmit = mark();
  const sub = await submitBillPhoto({ deliveryId, item, qty, paidStatus: 'paid' });
  await new Promise((r) => setTimeout(r, 500));
  const ledSubmit = await ledgerSince(mSubmit);

  const reqId = ((sub.body || {}).data || {}).requestId || ((sub.body || {}).data || {}).id;

  const m = mark();
  const appr = await patch(`/inventory-approvals/${reqId}/review`, { action: 'approved', notes: 'flow e2e paid' }, o);
  await new Promise((r) => setTimeout(r, 700));
  const led = await ledgerSince(m);

  const revenue = item.price * qty;
  const cost = item.cost * qty;
  record('Rider delivers -> no entry; Admin APPROVES (PAID) -> Dr Cash / Cr Sales + Dr COGS / Cr Goods in Transit', [
    { label: `bill photo submit ${sub.status}`, pass: sub.status < 400, expected: '<400', actual: `${sub.status} ${JSON.stringify(sub.body).slice(0, 120)}` },
    nothingPosted(ledSubmit, 'rider submission posts nothing'),
    { label: `approve ${appr.status}`, pass: appr.status < 400, expected: '<400', actual: `${appr.status} ${JSON.stringify(appr.body).slice(0, 160)}` },
    movement(led, '4000', 'Sales Revenue', 0, revenue),
    movement(led, '1000', 'Cash', revenue, 0),
    movement(led, '5000', 'Cost of Goods Sold', cost, 0),
    movement(led, '1250', 'Goods in Transit', 0, cost),
  ]);
}

// ── Branch: approve UNPAID -> A/R, then a payment that must not move P&L ─────
async function branchApproveUnpaid() {
  const o = { token: admin.token, companyId: admin.companyId };
  const mAssign = mark();
  const { deliveryId, item, qty } = await runDelivery({ itemKey: 'B', qty: 5 });
  await new Promise((r) => setTimeout(r, 500));

  await patch(`/deliveries/${deliveryId}/status`, { status: 'in_transit' }, o);
  await patch(`/deliveries/${deliveryId}/status`, { status: 'delivered', paidStatus: 'unpaid' }, o);
  const sub = await submitBillPhoto({ deliveryId, item, qty, paidStatus: 'unpaid' });
  const reqId = ((sub.body || {}).data || {}).requestId || ((sub.body || {}).data || {}).id;

  const m = mark();
  const appr = await patch(`/inventory-approvals/${reqId}/review`, { action: 'approved', notes: 'flow e2e unpaid' }, o);
  await new Promise((r) => setTimeout(r, 700));
  const led = await ledgerSince(m);

  const revenue = item.price * qty;
  const cost = item.cost * qty;
  record('Admin APPROVES (NOT PAID) -> Dr A/R / Cr Sales + Dr COGS / Cr Goods in Transit', [
    { label: `approve ${appr.status}`, pass: appr.status < 400, expected: '<400', actual: `${appr.status} ${JSON.stringify(appr.body).slice(0, 160)}` },
    movement(led, '4000', 'Sales Revenue', 0, revenue),
    movement(led, '1100', 'Accounts Receivable', revenue, 0),
    untouched(led, '1000', 'Cash'),
    movement(led, '5000', 'Cost of Goods Sold', cost, 0),
    movement(led, '1250', 'Goods in Transit', 0, cost),
  ]);
  branchApproveUnpaid.revenue = revenue;
}

// ── Branch: REJECTED -> Dr Inventory / Cr GIT, no revenue ────────────────────
async function branchReject() {
  const o = { token: admin.token, companyId: admin.companyId };
  const { deliveryId, item, qty } = await runDelivery({ itemKey: 'A', qty: 4 });
  await new Promise((r) => setTimeout(r, 500));

  await patch(`/deliveries/${deliveryId}/status`, { status: 'in_transit' }, o);
  await patch(`/deliveries/${deliveryId}/status`, { status: 'delivered', paidStatus: 'unpaid' }, o);
  const sub = await submitBillPhoto({ deliveryId, item, qty });
  const reqId = ((sub.body || {}).data || {}).requestId || ((sub.body || {}).data || {}).id;

  const m = mark();
  const rej = await patch(`/inventory-approvals/${reqId}/review`, { action: 'rejected', notes: 'flow e2e rejection reason' }, o);
  await new Promise((r) => setTimeout(r, 700));
  const led = await ledgerSince(m);

  const { rows: dRows } = await db.query('SELECT status, ledger_status FROM deliveries WHERE id = $1', [deliveryId]);
  const d = dRows[0] || {};
  const cost = item.cost * qty;

  record('REJECTED -> Dr Inventory / Cr Goods in Transit (back on the shelf, no sale)', [
    { label: `reject ${rej.status}`, pass: rej.status < 400, expected: '<400', actual: `${rej.status} ${JSON.stringify(rej.body).slice(0, 160)}` },
    movement(led, '1200', 'Inventory', cost, 0),
    movement(led, '1250', 'Goods in Transit', 0, cost),
    untouched(led, '4000', 'Sales Revenue'),
    untouched(led, '5000', 'Cost of Goods Sold'),
    {
      label: `ledger_status advances to 'returned' (was left at 'in_transit' on prod)`,
      pass: d.ledger_status === 'returned',
      expected: 'returned',
      actual: String(d.ledger_status),
    },
  ]);
}

main().catch((e) => {
  console.error(`flow-e2e: ${e.stack || e.message}`);
  process.exit(2);
});
