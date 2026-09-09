/**
 * Provision a throwaway warehouse company for qa/flow-e2e.js.
 *
 * flow-e2e.js needs a company, an admin, a rider, a customer, a vendor, two
 * PRICED and STOCKED items and the chart of accounts — and it used to expect
 * all of that to already exist, reading it from a qa/.flow-ctx.json that was
 * committed to the repo with hardcoded UUIDs. Those ids pointed at one
 * developer's database, so on any other machine every branch failed at signin
 * and `npm run qa:flow` could not be part of a release gate at all. Its own
 * error message said "provision a throwaway warehouse company first" without
 * saying how. This is the how.
 *
 * Writes qa/.flow-ctx.json (git-ignored — it names real credentials and ids for
 * one database, and is regenerated per run).
 *
 * The company it builds is disposable: the flow harness creates deliveries,
 * invoices, payments and journal entries in it. Never point this at books
 * anyone cares about.
 *
 * Usage:
 *   API_BASE=http://localhost:3000/api/v1 \
 *   DATABASE_URL=postgres://user:pass@localhost:5432/finmatrix \
 *   npx ts-node -r tsconfig-paths/register qa/provision-flow-ctx.ts
 *
 *   npm run qa:provision
 *
 * Needs DATABASE_URL. Three things gate every business request and none of
 * them can be done over the API by the account being created: the company has
 * to be APPROVED (normally a platform super-admin's job), the admin's email
 * has to be VERIFIED (normally a link in an inbox), and the company needs a
 * PLAN. All three are set directly here.
 *
 * Doing the approval in SQL rather than by signing in as the super-admin is
 * deliberate: it drops a credential this script would otherwise have to be
 * told, and which differs between every developer's database. A gate that
 * cannot run without a shared password is a gate nobody runs.
 */
/* eslint-disable @typescript-eslint/no-var-requires */
export {};

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB_URL = process.env.DATABASE_URL || process.env.PG_URL || '';
const CTX_PATH = process.env.FLOW_CTX || path.join(__dirname, '.flow-ctx.json');

const RUN = Date.now();
const TODAY = new Date().toISOString().slice(0, 10);
const ADMIN_PASSWORD = 'FlowTest123!';
const RIDER_PASSWORD = 'FlowRider123!';

/**
 * Stock levels.
 *
 * flow-e2e dispatches A twice (10 + 4) and B twice (5 + 3), and the credit-memo
 * branch invoices one more A. Stocked well above that so a partially-completed
 * previous run cannot starve the next one — a "not enough stock" 400 halfway
 * through reads like a ledger defect when it is only a provisioning shortfall.
 */
const ITEMS = {
  A: { sku: `FT-A-${RUN}`, name: 'Widget A', cost: 100, price: 150, stock: 60 },
  B: { sku: `FT-B-${RUN}`, name: 'Widget B', cost: 200, price: 300, stock: 40 },
};

interface Res {
  status: number;
  body: any;
}

async function req(
  method: string,
  p: string,
  opts: { token?: string; companyId?: string; json?: any } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.companyId) headers['x-company-id'] = opts.companyId;
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${API}${p}`, {
    method,
    headers,
    body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined,
  });
  let body: any = null;
  try {
    body = await r.json();
  } catch {
    /* empty */
  }
  return { status: r.status, body };
}

const data = (r: Res) => r.body?.data ?? r.body;

/** Signin retries through the throttler, which trips easily during setup. */
async function signin(email: string, password: string): Promise<Res> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await req('POST', '/auth/signin', { json: { email, password } });
    if (r.status !== 429) return r;
    console.log('    (signin throttled — waiting 15s)');
    await new Promise((res) => setTimeout(res, 15_000));
  }
  return req('POST', '/auth/signin', { json: { email, password } });
}

function must<T>(label: string, value: T, res?: Res): T {
  if (value === undefined || value === null || value === '' || value === false) {
    const detail = res ? ` (${res.status} ${JSON.stringify(res.body)?.slice(0, 200)})` : '';
    throw new Error(`provision failed: ${label}${detail}`);
  }
  console.log(`  · ${label}`);
  return value;
}

async function main() {
  if (!DB_URL) {
    throw new Error(
      'DATABASE_URL is required — the new company needs its email verified and a plan set directly.',
    );
  }

  console.log(`\nProvisioning a throwaway flow company → ${API}\n`);
  const pg = new Client({ connectionString: DB_URL });
  await pg.connect();

  try {
    // ── Admin + company ────────────────────────────────────────────────
    const adminEmail = `flowtest${RUN}@finmatrix.pk`;
    const signup = await req('POST', '/auth/signup', {
      json: {
        email: adminEmail,
        password: ADMIN_PASSWORD,
        displayName: 'Flow Test Dispatcher',
        phone: '+92-300-1234567',
        role: 'admin',
      },
    });
    const signupToken = must('admin signed up', data(signup)?.tokens?.accessToken, signup);
    const userId = must('admin user id', data(signup)?.user?.id, signup);

    const createCo = await req('POST', '/companies', {
      token: signupToken,
      json: { name: `FlowTest Warehouse ${RUN}`, industry: 'Retail' },
    });
    const companyId = must('company created', data(createCo)?.id, createCo);

    await req('POST', `/companies/${companyId}/submit`, {
      token: signupToken,
      companyId,
    });

    // CompanyGuard 403s every business request unless the company is active
    // and the signer's email is verified, and FeatureGuard needs a real plan.
    // None of that is reachable over the API as this user, so set it directly.
    await pg.query(`UPDATE users SET is_email_verified = true WHERE id = $1`, [userId]);
    await pg.query(
      `UPDATE companies SET status = 'active', subscription_plan = 'standard',
              subscription_status = 'active' WHERE id = $1`,
      [companyId],
    );
    must('company approved and put on a plan', true);

    const relogin = await signin(adminEmail, ADMIN_PASSWORD);
    const token = must('admin re-signed in with the company live', data(relogin)?.tokens?.accessToken, relogin);
    const A = { token, companyId };

    // ── Rider ──────────────────────────────────────────────────────────
    // Riders sign in with a USERNAME, never an email — '@' is what AuthService
    // uses to tell the two apart when resolving a handle, so the rider DTO
    // rejects anything containing one.
    const riderUsername = `flowrider${RUN}`;
    const riderRes = await req('POST', '/delivery-personnel', {
      ...A,
      json: {
        username: riderUsername,
        password: RIDER_PASSWORD,
        name: 'Flow Test Rider',
        email: `flowrider${RUN}@finmatrix.pk`,
      },
    });
    must('rider created', data(riderRes)?.userId ?? data(riderRes)?.id, riderRes);
    const riderLogin = await signin(riderUsername, RIDER_PASSWORD);
    must('rider can sign in', data(riderLogin)?.tokens?.accessToken, riderLogin);

    // ── Masters ────────────────────────────────────────────────────────
    const customerRes = await req('POST', '/customers', {
      ...A,
      json: { name: 'FlowTest Customer', email: `flow.customer.${RUN}@example.test` },
    });
    const customerId = must('customer created', data(customerRes)?.id, customerRes);

    const vendorRes = await req('POST', '/vendors', {
      ...A,
      json: { companyName: `FlowTest Vendor ${RUN}` },
    });
    const vendorId = must('vendor created', data(vendorRes)?.id, vendorRes);

    // Items are created at unitCost 0 and given their cost by a real PO
    // receipt below, so weighted-average costing is established the way it is
    // in production rather than by writing a number onto the item.
    //
    // Both carry a REAL selling price. An item priced at 0 cannot be approved
    // on a delivery — that is the DELIVERY_ITEM_NO_PRICE guard doing its job —
    // so an unpriced item here would fail the harness for the right reason at
    // the wrong time.
    const items: Record<string, any> = {};
    for (const [key, spec] of Object.entries(ITEMS)) {
      const res = await req('POST', '/inventory/items', {
        ...A,
        json: {
          sku: spec.sku,
          name: spec.name,
          unitOfMeasure: 'unit',
          costMethod: 'average',
          unitCost: '0',
          sellingPrice: String(spec.price),
        },
      });
      const created = data(res);
      const id = must(`item ${key} (${spec.name}) created`, created?.id ?? created?.item?.id, res);
      items[key] = { id, name: spec.name, sku: spec.sku, cost: spec.cost, price: spec.price };
    }

    // ── Stock both items through a real purchase cycle ─────────────────
    for (const [key, spec] of Object.entries(ITEMS)) {
      const poRes = await req('POST', '/purchase-orders', {
        ...A,
        json: {
          vendorId,
          orderDate: TODAY,
          lines: [
            {
              description: spec.name,
              orderedQty: String(spec.stock),
              unitCost: String(spec.cost),
              itemId: items[key].id,
            },
          ],
        },
      });
      const po = must(`PO for ${key}`, data(poRes)?.id ? data(poRes) : null, poRes);

      const recRes = await req('POST', `/purchase-orders/${po.id}/receive`, {
        ...A,
        json: {
          lines: (po.lines || []).map((l: any) => ({
            lineId: l.id,
            receivedQty: String(spec.stock),
          })),
        },
      });
      must(`received ${spec.stock} × ${key} @ ${spec.cost}`, recRes.status < 400, recRes);

      // Bill it so GRNI nets to zero before the harness starts. The harness's
      // own supplier-side branch asserts a company-wide GRNI balance of zero,
      // which stock left un-billed here would break.
      const billRes = await req('POST', `/purchase-orders/${po.id}/create-bill`, {
        ...A,
        json: {
          billNumber: `FT-PROV-${key}-${RUN}`,
          billDate: TODAY,
          dueDate: TODAY,
        },
      });
      must(`billed the ${key} receipt (GRNI back to zero)`, billRes.status < 400, billRes);
    }

    // ── Chart of accounts, by number ───────────────────────────────────
    const acctRes = await req('GET', '/accounts?limit=200', A);
    const acctBody = data(acctRes);
    const list = acctBody?.accounts ?? acctBody?.data ?? acctBody ?? [];
    must('accounts fetched', Array.isArray(list) && list.length > 0, acctRes);
    const accounts: Record<string, { id: string; name: string }> = {};
    for (const a of list) accounts[a.accountNumber] = { id: a.id, name: a.name };
    must(
      'cash/bank accounts present (the harness pays bills from one)',
      !!(accounts['1010'] || accounts['1000']),
    );

    // ── Write the context ──────────────────────────────────────────────
    const ctx = {
      companyId,
      admin: { email: adminEmail, password: ADMIN_PASSWORD },
      // flow-e2e posts this object straight to /auth/signin, whose `email`
      // field accepts a username too (it is deliberately not @IsEmail, so old
      // clients keep working). The rider's handle IS a username; the key is
      // named `email` only because that is the field signin reads.
      rider: { email: riderUsername, password: RIDER_PASSWORD },
      seed: { customerId, vendorId, items, accounts },
    };
    fs.writeFileSync(CTX_PATH, JSON.stringify(ctx, null, 1));

    console.log(`\n  context written to ${CTX_PATH}`);
    console.log(`  company ${companyId}`);
    console.log(`\nNow run:  npm run qa:flow\n`);
  } finally {
    await pg.end();
  }
}

main().catch((e) => {
  console.error('\nPROVISION FAILED:', e?.message ?? e);
  process.exit(2);
});
