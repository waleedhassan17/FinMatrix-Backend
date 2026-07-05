/**
 * phase3.md CHUNK 1 — non-ledger surface acceptance test (HTTP, end-to-end).
 *
 * Proves, against a running API:
 *   1. Delivery status machine: legal chain works; skips/reverts rejected;
 *      double-tapped/replayed updates are idempotent (no duplicate history);
 *      riders can only touch their own deliveries and cannot cancel.
 *   2. Role isolation: a delivery token is rejected (403) by admin and
 *      financial endpoints.
 *   3. Cross-tenant isolation: company B cannot read company A's records.
 *   4. Personnel plan limit (Free = 1) with the upgrade message.
 *   5. Proof-of-delivery photo: uploaded, stored durably (Postgres bytea /
 *      Cloudinary — never dyno disk), streamed back byte-identical through
 *      the auth-gated endpoint, invisible to other tenants; approval loop
 *      approve + duplicate-approve conflict.
 *   6. Customer/vendor record management: app-shaped payloads persist
 *      (contactPerson/taxId/postalCode/terms), paginated + searchable lists,
 *      delete guard (records with activity are blocked, clean ones delete).
 *   7. Client-error monitoring intake accepts a thrown test error.
 *
 * Run against a booted server:
 *   BASE_URL=http://localhost:3001/api/v1 \
 *   PG_URL=postgres://postgres:pass@localhost:5432/finmatrix_qa \
 *   node -r ts-node/register -r tsconfig-paths/register test/chunk1.acceptance.ts
 */
/* eslint-disable @typescript-eslint/no-var-requires */
export {};
const { Client } = require('pg');

const BASE = process.env.BASE_URL || 'http://localhost:3001/api/v1';
const PG_URL = process.env.PG_URL as string;
const SUPER_EMAIL = process.env.SUPER_EMAIL || 'waleedhassansfd@gmail.com';
const SUPER_PASSWORD = process.env.SUPER_PASSWORD || 'Waleed@104';

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    fails.push(name);
    console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`);
  }
}

interface Res { status: number; body: any; }
async function signin(email: string, password: string): Promise<Res> {
  // Signin is throttled to 5/minute per IP; wait out the window on 429.
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await req('POST', '/auth/signin', { json: { email, password } });
    if (r.status !== 429) return r;
    console.log('    (signin throttled — waiting 15s)');
    await new Promise(res => setTimeout(res, 15_000));
  }
  return req('POST', '/auth/signin', { json: { email, password } });
}
async function req(
  method: string,
  path: string,
  opts: { token?: string; companyId?: string; json?: any } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.companyId) headers['x-company-id'] = opts.companyId;
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  let body: any = null;
  try { body = await r.json(); } catch { /* empty */ }
  return { status: r.status, body };
}
const data = (r: Res) => r.body?.data ?? r.body;
const errCode = (r: Res) => r.body?.error?.code ?? r.body?.message ?? '';

// 1x1 PNG for the proof-of-delivery photo
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

async function signupApprovedAdmin(pg: any, superToken: string, tag: string) {
  const email = `qa_${tag}_${Date.now()}@qa.local`;
  const signup = await req('POST', '/auth/signup', {
    json: { email, password: 'Qa@12345', displayName: `QA ${tag}`, phone: '+92-300-1234567', role: 'admin' },
  });
  const token0 = data(signup)?.tokens?.accessToken;
  const userId = data(signup)?.user?.id;
  const createCo = await req('POST', '/companies', {
    token: token0,
    json: { name: `QA ${tag} Co ${Date.now()}`, industry: 'Retail' },
  });
  const companyId = data(createCo)?.id;
  await req('POST', `/companies/${companyId}/submit`, { token: token0, companyId });
  await req('PATCH', `/admin/companies/${companyId}/approve`, { token: superToken });
  await pg.query(`UPDATE users SET is_email_verified = true WHERE id = $1`, [userId]);
  const relogin = await req('POST', '/auth/signin', { json: { email, password: 'Qa@12345' } });
  const token = data(relogin)?.tokens?.accessToken;
  return { email, token, userId, companyId };
}

async function main() {
  if (!PG_URL) throw new Error('PG_URL is required');
  const pg = new Client({ connectionString: PG_URL });
  await pg.connect();

  console.log(`\n=== phase3 Chunk 1 acceptance @ ${BASE} ===\n`);

  // ── Setup: super admin + two companies ─────────────────────────────────
  console.log('— Setup');
  const superLogin = await req('POST', '/auth/signin', { json: { email: SUPER_EMAIL, password: SUPER_PASSWORD } });
  const superToken = data(superLogin)?.tokens?.accessToken;
  check('super-admin signs in', !!superToken, superLogin.status);

  const A = await signupApprovedAdmin(pg, superToken, 'alpha');
  check('company A admin ready', !!A.token && !!A.companyId);
  const B = await signupApprovedAdmin(pg, superToken, 'beta');
  check('company B admin ready', !!B.token && !!B.companyId);

  // ── 6. Customer/vendor record management ───────────────────────────────
  console.log('\n— Records (customers/vendors)');
  const custCreate = await req('POST', '/customers', {
    token: A.token, companyId: A.companyId,
    json: {
      name: 'Chunk1 Customer',
      email: 'c1@qa.local',
      phone: '+92-300-0000001',
      contactPerson: 'Contact Ali',
      taxId: 'NTN-12345',
      creditLimit: '50000',
      paymentTerms: 'net30',
      billingAddress: { street: '12 Mall Rd', city: 'Lahore', state: 'Punjab', postalCode: '54000', country: 'Pakistan' },
      shippingAddress: { street: '12 Mall Rd', city: 'Lahore', state: 'Punjab', zipCode: '54000', country: 'Pakistan' },
    },
  });
  const customerId = data(custCreate)?.id;
  check('customer created (app-shaped payload, zipCode alias accepted)', custCreate.status === 201 && !!customerId, custCreate.body);

  const custDetail = data(await req('GET', `/customers/${customerId}`, { token: A.token, companyId: A.companyId }));
  check('contactPerson + taxId persisted (were silently stripped before)',
    custDetail?.customer?.contactPerson === 'Contact Ali' && custDetail?.customer?.taxId === 'NTN-12345', custDetail?.customer);
  check('shipping zipCode alias mapped to postalCode',
    custDetail?.customer?.shippingAddress?.postalCode === '54000', custDetail?.customer?.shippingAddress);
  check('detail returns totalPurchases', custDetail?.totalPurchases !== undefined, custDetail);

  const custList = data(await req('GET', '/customers?page=1&limit=1', { token: A.token, companyId: A.companyId }));
  check('customer list paginated {data, pagination}',
    Array.isArray(custList?.data) && custList?.pagination?.page === 1 && custList?.pagination?.limit === 1, custList?.pagination);
  const custSearch = data(await req('GET', '/customers?search=Chunk1', { token: A.token, companyId: A.companyId }));
  check('customer list searchable', (custSearch?.data ?? []).some((c: any) => c.id === customerId));

  const vendCreate = await req('POST', '/vendors', {
    token: A.token, companyId: A.companyId,
    json: {
      companyName: 'Chunk1 Vendor Pvt',
      contactPerson: 'Vendor Guy',
      paymentTerms: 'net15',
      address: { street: '1 Industrial Ave', city: 'Karachi', postalCode: '74000', country: 'Pakistan' },
    },
  });
  const vendorId = data(vendCreate)?.id;
  check('vendor created (DTO-shaped payload)', vendCreate.status === 201 && !!vendorId, vendCreate.body);
  const vendStatement = await req('GET', `/vendors/${vendorId}/statement?startDate=2026-01-01&endDate=2026-12-31`, { token: A.token, companyId: A.companyId });
  check('vendor statement endpoint works', vendStatement.status === 200 && data(vendStatement)?.vendor?.id === vendorId, vendStatement.status);

  // Delete guard: clean record deletes; record with balance is blocked.
  const tmpCust = data(await req('POST', '/customers', {
    token: A.token, companyId: A.companyId, json: { name: 'Deletable' },
  }));
  const delOk = await req('DELETE', `/customers/${tmpCust?.id}`, { token: A.token, companyId: A.companyId });
  check('clean customer hard-deletes (softRemove no-op fixed)', delOk.status === 200 && data(delOk)?.deleted === true, delOk.body);
  await pg.query(`UPDATE customers SET balance = 100 WHERE id = $1`, [customerId]);
  const delBlocked = await req('DELETE', `/customers/${customerId}`, { token: A.token, companyId: A.companyId });
  check('customer with balance blocked (CUSTOMER_HAS_ACTIVITY)', delBlocked.status === 400 && errCode(delBlocked) === 'CUSTOMER_HAS_ACTIVITY', delBlocked.body);
  await pg.query(`UPDATE customers SET balance = 0 WHERE id = $1`, [customerId]);

  // ── 4. Personnel plan limit (Free = 1) ─────────────────────────────────
  console.log('\n— Personnel plan limit');
  const rider1 = await req('POST', '/delivery-personnel', {
    token: A.token, companyId: A.companyId,
    json: { email: `rider1_${Date.now()}@qa.local`, password: 'Rider@123', name: 'Rider One', vehicleType: 'motorcycle' },
  });
  const rider1Id = data(rider1)?.userId;
  const rider1Email = data(rider1)?.email;
  check('rider 1 created', rider1.status === 201 && !!rider1Id, rider1.body);

  const rider2Blocked = await req('POST', '/delivery-personnel', {
    token: A.token, companyId: A.companyId,
    json: { email: `rider2_${Date.now()}@qa.local`, password: 'Rider@123', name: 'Rider Two' },
  });
  check('2nd rider blocked on Free plan with upgrade message',
    rider2Blocked.status === 400 &&
    errCode(rider2Blocked) === 'DELIVERY_PERSONNEL_LIMIT_REACHED' &&
    String(rider2Blocked.body?.error?.message ?? '').toLowerCase().includes('upgrade'),
    rider2Blocked.body);

  // Upgrade the plan (server-side poke) so we can create rider 2 for the
  // ownership tests.
  await pg.query(`UPDATE companies SET subscription_plan = 'standard' WHERE id = $1`, [A.companyId]);
  const rider2 = await req('POST', '/delivery-personnel', {
    token: A.token, companyId: A.companyId,
    json: { email: `rider2b_${Date.now()}@qa.local`, password: 'Rider@123', name: 'Rider Two' },
  });
  const rider2Id = data(rider2)?.userId;
  const rider2Email = data(rider2)?.email;
  check('rider 2 allowed after upgrade', rider2.status === 201 && !!rider2Id, rider2.body);

  const rider1Login = await req('POST', '/auth/signin', { json: { email: rider1Email, password: 'Rider@123' } });
  const rider1Token = data(rider1Login)?.tokens?.accessToken;
  check('rider 1 signs in', !!rider1Token, rider1Login.status);
  const rider2Login = await req('POST', '/auth/signin', { json: { email: rider2Email, password: 'Rider@123' } });
  const rider2Token = data(rider2Login)?.tokens?.accessToken;
  check('rider 2 signs in', !!rider2Token, rider2Login.status);

  // ── 2. Role isolation: delivery token → 403 everywhere sensitive ───────
  console.log('\n— Role isolation (rider token 403 on admin/financial endpoints)');
  const riderDenied: Array<[string, string, any?]> = [
    ['POST', '/customers', { name: 'X' }],
    ['POST', '/vendors', { companyName: 'X' }],
    ['POST', '/invoices', { customerId, invoiceDate: '2026-07-01', dueDate: '2026-07-30', lines: [] }],
    ['GET', '/reports/profit-loss?startDate=2026-01-01&endDate=2026-12-31'],
    ['GET', '/settings/users'],
    ['POST', '/delivery-personnel', { email: 'x@x.com', password: 'Xx@12345' }],
    ['POST', '/deliveries', { customerId, items: [] }],
    ['GET', '/deliveries/map-data'],
    ['POST', '/agencies', { name: 'X' }],
    ['GET', '/inventory-update-requests'],
    ['POST', '/taxes/rates', { name: 'X', rate: '1' }],
    ['GET', '/accounts'],
  ];
  for (const [method, path, json] of riderDenied) {
    const r = await req(method, path, { token: rider1Token, companyId: A.companyId, json });
    check(`rider ${method} ${path.split('?')[0]} → 403`, r.status === 403, `${r.status} ${JSON.stringify(r.body?.error ?? r.body)}`);
  }
  const riderAllowed = await req('GET', '/deliveries', { token: rider1Token, companyId: A.companyId });
  check('rider GET /deliveries (own) still allowed', riderAllowed.status === 200, riderAllowed.status);

  // ── 1. Delivery status machine ─────────────────────────────────────────
  console.log('\n— Delivery status machine');
  const item = data(await req('POST', '/inventory/items', {
    token: A.token, companyId: A.companyId,
    json: { sku: `SKU-${Date.now()}`, name: 'QA Crate', unitCost: '100', sellingPrice: '150' },
  }));
  const itemId = item?.id ?? item?.item?.id;
  check('inventory item created', !!itemId, item);
  await pg.query(`UPDATE inventory_items SET quantity_on_hand = 50 WHERE id = $1`, [itemId]);

  const delCreate = await req('POST', '/deliveries', {
    token: A.token, companyId: A.companyId,
    json: {
      customerId,
      customerName: 'Chunk1 Customer',
      personnelId: rider1Id,
      items: [{ itemId, itemName: 'QA Crate', orderedQty: 2, unitPrice: 150 }],
    },
  });
  const deliveryId = data(delCreate)?.id;
  check('delivery created + assigned to rider 1', delCreate.status === 201 && !!deliveryId && data(delCreate)?.status === 'pending', delCreate.body);

  // rider 2 cannot touch rider 1's delivery
  const foreign = await req('PATCH', `/deliveries/${deliveryId}/status`, {
    token: rider2Token, companyId: A.companyId, json: { status: 'picked_up' },
  });
  check('rider 2 blocked from rider 1 delivery (NOT_YOUR_DELIVERY)', foreign.status === 403 && errCode(foreign) === 'NOT_YOUR_DELIVERY', foreign.body);

  // illegal skip pending → arrived
  const skip = await req('PATCH', `/deliveries/${deliveryId}/status`, {
    token: rider1Token, companyId: A.companyId, json: { status: 'arrived' },
  });
  check('skip pending→arrived rejected (ILLEGAL_STATUS_TRANSITION)', skip.status === 400 && errCode(skip) === 'ILLEGAL_STATUS_TRANSITION', skip.body);

  // legal advance
  const adv1 = await req('PATCH', `/deliveries/${deliveryId}/status`, {
    token: rider1Token, companyId: A.companyId, json: { status: 'picked_up' },
  });
  check('pending→picked_up allowed', adv1.status === 200, adv1.body);

  // idempotent replay: same status again succeeds, adds NO history row
  const rows = (r: Res) => {
    const d = data(r);
    return Array.isArray(d) ? d : (d?.data ?? []);
  };
  const historyBefore = rows(await req('GET', `/deliveries/${deliveryId}/history`, { token: A.token, companyId: A.companyId }));
  const replay = await req('PATCH', `/deliveries/${deliveryId}/status`, {
    token: rider1Token, companyId: A.companyId, json: { status: 'picked_up' },
  });
  const historyAfter = rows(await req('GET', `/deliveries/${deliveryId}/history`, { token: A.token, companyId: A.companyId }));
  check('replayed update succeeds (idempotent)', replay.status === 200, replay.body);
  check('replay adds no duplicate history row', historyAfter.length === historyBefore.length && historyBefore.length > 0,
    { before: historyBefore.length, after: historyAfter.length });

  // revert rejected
  const revert = await req('PATCH', `/deliveries/${deliveryId}/status`, {
    token: rider1Token, companyId: A.companyId, json: { status: 'pending' },
  });
  check('revert picked_up→pending rejected', revert.status === 400, revert.body);

  // rider cannot cancel
  const riderCancel = await req('PATCH', `/deliveries/${deliveryId}/status`, {
    token: rider1Token, companyId: A.companyId, json: { status: 'cancelled' },
  });
  check('rider cancel rejected (RIDER_CANNOT_CANCEL)', riderCancel.status === 403 && errCode(riderCancel) === 'RIDER_CANNOT_CANCEL', riderCancel.body);

  // continue the legal chain
  const adv2 = await req('PATCH', `/deliveries/${deliveryId}/status`, {
    token: rider1Token, companyId: A.companyId, json: { status: 'in_transit' },
  });
  const adv3 = await req('PATCH', `/deliveries/${deliveryId}/status`, {
    token: rider1Token, companyId: A.companyId, json: { status: 'arrived' },
  });
  check('picked_up→in_transit→arrived allowed', adv2.status === 200 && adv3.status === 200, { s2: adv2.status, s3: adv3.status });

  // ── 5. Proof-of-delivery photo + approval loop ─────────────────────────
  console.log('\n— POD photo upload + durable storage + approval');
  const fd = new FormData();
  fd.append('photo', new Blob([PNG], { type: 'image/png' }), 'bill.png');
  fd.append('signedBy', 'QA Customer');
  fd.append('source', 'camera');
  fd.append('changes', JSON.stringify([{ itemId, itemName: 'QA Crate', beforeQty: 50, deliveredQty: 2, returnedQty: 0 }]));
  const upload = await fetch(`${BASE}/deliveries/${deliveryId}/bill-photo`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${rider1Token}`, 'x-company-id': A.companyId },
    body: fd as any,
  });
  const uploadBody: any = await upload.json().catch(() => null);
  const requestId = uploadBody?.data?.requestId;
  check('rider uploads POD photo → pending approval request', upload.status === 201 && !!requestId, uploadBody);

  const storedKeyRow = await pg.query(
    `SELECT proof_bill_photo_storage_key AS key FROM inventory_update_requests WHERE id = $1`, [requestId],
  );
  const storedKey: string = storedKeyRow.rows[0]?.key ?? '';
  check('photo stored durably (db:/cld: key — NOT a disk path)', storedKey.startsWith('db:') || storedKey.startsWith('cld:'), storedKey);

  const photoRes = await fetch(`${BASE}/inventory-update-requests/${requestId}/bill-photo`, {
    headers: { Authorization: `Bearer ${A.token}`, 'x-company-id': A.companyId },
  });
  const photoBytes = Buffer.from(await photoRes.arrayBuffer());
  check('admin streams photo back byte-identical', photoRes.status === 200 && photoBytes.equals(PNG),
    { status: photoRes.status, bytes: photoBytes.length });

  // Cross-tenant: company B admin cannot see it.
  const photoB = await req('GET', `/inventory-update-requests/${requestId}/bill-photo`, { token: B.token, companyId: B.companyId });
  check('company B cannot access company A photo', photoB.status === 404 || photoB.status === 403, photoB.status);

  const approve = await req('POST', `/inventory-update-requests/${requestId}/approve`, {
    token: A.token, companyId: A.companyId, json: {},
  });
  check('admin approves request', approve.status in { 200: 1, 201: 1 }, approve.body);
  const reApprove = await req('POST', `/inventory-update-requests/${requestId}/approve`, {
    token: A.token, companyId: A.companyId, json: {},
  });
  check('double-approve rejected (409)', reApprove.status === 409, reApprove.status);
  const qtyRow = await pg.query(`SELECT quantity_on_hand::numeric AS q FROM inventory_items WHERE id = $1`, [itemId]);
  check('approved delivery deducted stock (50 → 48)', Number(qtyRow.rows[0]?.q) === 48, qtyRow.rows[0]);
  const delAfter = data(await req('GET', `/deliveries/${deliveryId}`, { token: A.token, companyId: A.companyId }));
  check('delivery completed after approval', delAfter?.status === 'delivered', delAfter?.status);

  // terminal: no further updates
  const afterTerminal = await req('PATCH', `/deliveries/${deliveryId}/status`, {
    token: A.token, companyId: A.companyId, json: { status: 'in_transit' },
  });
  check('terminal delivery rejects further transitions', afterTerminal.status === 400, afterTerminal.status);

  // ── 3. Cross-tenant isolation ──────────────────────────────────────────
  console.log('\n— Cross-tenant isolation');
  const bReadsCustomer = await req('GET', `/customers/${customerId}`, { token: B.token, companyId: B.companyId });
  check('company B cannot read company A customer', bReadsCustomer.status === 404, bReadsCustomer.status);
  const bReadsDelivery = await req('GET', `/deliveries/${deliveryId}`, { token: B.token, companyId: B.companyId });
  check('company B cannot read company A delivery', bReadsDelivery.status === 404, bReadsDelivery.status);
  const bSpoofsHeader = await req('GET', `/customers/${customerId}`, { token: B.token, companyId: A.companyId });
  check('company B cannot spoof x-company-id header', bSpoofsHeader.status === 403 || bSpoofsHeader.status === 404, bSpoofsHeader.status);

  // ── Personnel management flows ─────────────────────────────────────────
  console.log('\n— Personnel reset-password / deactivate (audited)');
  const reset = await req('POST', `/delivery-personnel/${rider2Id}/reset-password`, { token: A.token, companyId: A.companyId });
  const creds = data(reset)?.credentials;
  check('reset-password returns temp credentials with real email', reset.status === 201 && creds?.email === rider2Email && !!creds?.temporaryPassword, data(reset));
  const reLogin = await signin(rider2Email, creds?.temporaryPassword);
  check('rider signs in with temp password', !!data(reLogin)?.tokens?.accessToken, reLogin.status);

  const deactivate = await req('PATCH', `/delivery-personnel/${rider2Id}`, {
    token: A.token, companyId: A.companyId, json: { status: 'inactive' },
  });
  check('rider deactivated (data kept)', deactivate.status === 200, deactivate.body);
  const auditRows = await pg.query(
    `SELECT action FROM operational_audit_events WHERE company_id = $1 AND target_id = $2 ORDER BY created_at`,
    [A.companyId, rider2Id],
  );
  const actions = auditRows.rows.map((r: any) => r.action);
  check('audit trail recorded reset + deactivate',
    actions.includes('personnel_password_reset') && actions.includes('personnel_deactivated'), actions);

  // ── 7. Client-error monitoring intake ──────────────────────────────────
  console.log('\n— Error monitoring');
  const clientErr = await req('POST', '/monitoring/client-errors', {
    token: A.token, companyId: A.companyId,
    json: { message: 'chunk1 acceptance test error', stack: 'Error: test\n  at qa', screen: 'QAScreen', platform: 'android', kind: 'error' },
  });
  check('client error intake accepts a thrown test error (202)', clientErr.status === 202 && data(clientErr)?.received === true, clientErr.status);

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fails.length) {
    console.log('Failed:');
    fails.forEach(f => console.log(`  - ${f}`));
  }
  await pg.end();
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});
