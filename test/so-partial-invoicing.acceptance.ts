/**
 * FinMatrix — sales orders: partial invoicing, the rest of the shipment, closing
 * ===========================================================================
 * The reported bug: an order half shipped and then invoiced billed the FULL
 * ordered quantity, froze as 'invoiced', and the rest could never be shipped.
 *
 *   P1-P4  ship 5 of 10 → invoice bills 5 (COGS/stock for 5) → order stays
 *          partial → ship the rest → invoice 5 → invoiced, two invoices.
 *   P5-P7  invoice with closeRemaining → closed (commits no stock); void →
 *          back to partial; close / reopen rules.
 *   P8     one-step convert of an untouched order, then void → open again,
 *          no phantom shipment in credit exposure.
 *   P9     an order invoiced in full the old way with 4 of 10 shipped: the
 *          rest can now be recorded as shipped, with no stock/credit re-check.
 *   P10    a staff request that went stale is refused; a fresh one bills
 *          exactly what the owner reviewed.
 *   P11    a fixed discount is shared out across invoices and adds up.
 *   P12    cancel / delete refused once goods shipped or were invoiced.
 *   P13    shipping is limited by what is physically on the shelf.
 *
 * Usage: boot the API against a scratch database, then
 *   API_BASE=http://localhost:3000/api/v1 DATABASE_URL=postgres://… \
 *   npm run test:so-partial
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: process.env.BUSINESS_TIMEZONE || 'Asia/Karachi',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
const RUN = Date.now().toString(36).toUpperCase();

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
const n = (v: unknown) => Number(v ?? 0) || 0;
const near = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

let TOKEN = '';
let COMPANY = '';

async function req(
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  const t = token ?? TOKEN;
  if (t) headers.Authorization = `Bearer ${t}`;
  if (COMPANY) headers['x-company-id'] = COMPANY;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429 && attempt < 3) {
      const wait = path.startsWith('/auth') ? 65_000 : 15_000 * (attempt + 1);
      console.log(`    (throttled on ${path} — waiting ${wait / 1000}s)`);
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
const errCode = (r: { body: any }) => r.body?.error?.code ?? r.body?.code;

async function main() {
  const db = new Client({ connectionString: DB });
  await db.connect();
  const sql = async (text: string, params: unknown[] = []) =>
    (await db.query(text, params)).rows;
  console.log(`\nFinMatrix SO partial invoicing → ${API}  (${TODAY})\n`);

  const login = await req('POST', '/auth/signin', {
    email: EMAIL,
    password: PASSWORD,
  });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  ok('owner signs in', !!TOKEN && !!COMPANY, login.status);
  if (!TOKEN) throw new Error('cannot sign in');
  await sql(`UPDATE companies SET books_locked_until = NULL WHERE id = $1`, [
    COMPANY,
  ]);

  const newItem = async (label: string, qty: number) => {
    const item = data(
      await req('POST', '/inventory/items', {
        sku: `SOP-${label}-${RUN}`,
        name: `SOP ${label} ${RUN}`,
        unitOfMeasure: 'unit',
        sellingPrice: '100',
        unitCost: '40',
      }),
    );
    if (qty > 0) {
      const opened = await req(
        'POST',
        `/inventory/items/${item.id}/opening-stock`,
        { quantity: String(qty), asOfDate: TODAY },
      );
      if (opened.status >= 300) throw new Error(JSON.stringify(opened.body));
    }
    return item;
  };
  const onHand = async (itemId: string) =>
    n(
      (
        await sql(
          `SELECT quantity_on_hand FROM inventory_items WHERE id = $1`,
          [itemId],
        )
      )[0]?.quantity_on_hand,
    );
  const customer = data(
    await req('POST', '/customers', { name: `SOP Buyer ${RUN}` }),
  );
  const order = async (
    lines: Array<{ itemId: string; quantity: number; price?: number }>,
    extra: Record<string, unknown> = {},
  ) =>
    data(
      await req('POST', '/sales-orders', {
        customerId: customer.id,
        orderDate: TODAY,
        acceptBackorder: true,
        ...extra,
        lines: lines.map((l) => ({
          description: `Line ${l.itemId.slice(0, 4)}`,
          itemId: l.itemId,
          lineKind: 'item',
          quantity: String(l.quantity),
          unitPrice: String(l.price ?? 100),
          taxRate: '0',
        })),
      }),
    );
  const detail = async (id: string) =>
    data(await req('GET', `/sales-orders/${id}`));
  const ship = (so: any, totals: number[], token?: string) =>
    req(
      'POST',
      `/sales-orders/${so.id}/fulfill`,
      {
        lines: so.lines.map((l: any, i: number) => ({
          lineId: l.id,
          quantityFulfilled: String(totals[i]),
        })),
      },
      token,
    );
  const convert = (
    id: string,
    body: Record<string, unknown> = {},
    token?: string,
  ) => req('POST', `/sales-orders/${id}/convert-to-invoice`, body, token);

  // ── P1-P4 ship half, invoice half, ship the rest, invoice the rest ─────────
  console.log(
    '\nP1-P4. Half shipped → invoice bills half; the rest still ships',
  );
  const itemA = await newItem('A', 100);
  const startA = await onHand(itemA.id);
  let so = await order([{ itemId: itemA.id, quantity: 10 }]);
  await ship(so, [5]);
  const preview = data(
    await req('GET', `/sales-orders/${so.id}/invoice-preview`),
  );
  ok(
    'P1a preview bills the 5 shipped',
    preview?.mode === 'shipped' && n(preview?.lines?.[0]?.quantity) === 5,
    preview,
  );
  const inv1Res = await convert(so.id);
  const inv1 = data(inv1Res)?.invoice;
  let d = await detail(so.id);
  ok(
    'P1b invoice bills 5, not 10',
    inv1Res.status === 201 &&
      n(inv1?.lines?.[0]?.quantity) === 5 &&
      near(n(inv1?.total), 500),
    inv1Res.body,
  );
  ok(
    'P1c stock left the books for 5 only',
    (await onHand(itemA.id)) === startA - 5,
  );
  ok(
    'P1d order stays partial, 5 to ship, Record shipment available',
    d.status === 'partial' &&
      n(d.totals?.toShip) === 5 &&
      d.actions?.ship === true,
    { status: d.status, totals: d.totals, actions: d.actions },
  );
  const again = await convert(so.id);
  ok(
    'P2 invoicing again: nothing to invoice',
    errCode(again) === 'NOTHING_TO_INVOICE',
    again.body,
  );
  const lower = await ship(d, [3]);
  ok(
    'P3 cannot lower shipped below invoiced',
    errCode(lower) === 'SHIPPED_BELOW_INVOICED',
    lower.body,
  );
  await ship(d, [10]);
  d = await detail(so.id);
  ok('P4a fully shipped → fulfilled', d.status === 'fulfilled', d.status);
  const inv2 = data(await convert(so.id))?.invoice;
  d = await detail(so.id);
  ok(
    'P4b second invoice bills the other 5 → invoiced, two invoices',
    n(inv2?.lines?.[0]?.quantity) === 5 &&
      d.status === 'invoiced' &&
      d.invoices?.length === 2 &&
      d.invoiceId === inv2?.id,
    { status: d.status, invoices: d.invoices?.length },
  );
  ok('P4c all 10 off the books', (await onHand(itemA.id)) === startA - 10);
  const invDetail = data(await req('GET', `/invoices/${inv2?.id}`));
  ok(
    'P4d invoice links back to the order',
    invDetail?.salesOrderId === so.id &&
      invDetail?.salesOrderNumber === so.orderNumber,
    { salesOrderId: invDetail?.salesOrderId, n: invDetail?.salesOrderNumber },
  );

  // ── P5-P7 close the rest ───────────────────────────────────────────────────
  console.log(
    '\nP5-P7. Invoice and close the rest; void; close / reopen rules',
  );
  const itemB = await newItem('B', 20);
  so = await order([{ itemId: itemB.id, quantity: 10 }]);
  await ship(so, [5]);
  const closingRes = await convert(so.id, { closeRemaining: true });
  const closingInv = data(closingRes)?.invoice;
  d = await detail(so.id);
  ok(
    'P5a invoice + close → closed',
    d.status === 'closed' && n(closingInv?.total) === 500,
    {
      status: d.status,
      body: closingRes.status,
    },
  );
  const refusedShip = await ship(d, [8]);
  ok(
    'P5b a closed order does not ship',
    errCode(refusedShip) === 'CANNOT_FULFILL',
    refusedShip.body,
  );
  const probe = await order([{ itemId: itemB.id, quantity: 1 }]);
  const probeD = await detail(probe.id);
  ok(
    'P5c the closed order commits nothing (another order sees none committed)',
    n(probeD.lines?.[0]?.stock?.committed) === 0,
    probeD.lines?.[0]?.stock,
  );
  await req('DELETE', `/sales-orders/${probe.id}`);
  const voided = await req('POST', `/invoices/${closingInv.id}/void`, {
    reason: 'wrong price',
  });
  d = await detail(so.id);
  ok(
    'P6a voiding its invoice reopens it for billing (partial, 5 to invoice)',
    voided.status < 300 &&
      d.status === 'partial' &&
      n(d.totals?.toInvoice) === 5,
    { status: d.status, totals: d.totals },
  );
  const doubleVoid = await req('POST', `/invoices/${closingInv.id}/void`, {
    reason: 'again',
  });
  ok(
    'P6b voiding twice is refused',
    errCode(doubleVoid) === 'ALREADY_VOID',
    doubleVoid.body,
  );
  const closeUnbilled = await req('POST', `/sales-orders/${so.id}/close`, {});
  ok(
    'P7a closing with shipped goods unbilled is refused',
    errCode(closeUnbilled) === 'SO_HAS_UNINVOICED_SHIPMENTS',
    closeUnbilled.body,
  );
  await convert(so.id);
  const closed = await req('POST', `/sales-orders/${so.id}/close`, {
    reason: 'Customer cancelled the rest',
  });
  ok(
    'P7b close after invoicing → closed',
    data(closed)?.status === 'closed',
    closed.body,
  );
  const reopened = await req('POST', `/sales-orders/${so.id}/reopen`);
  ok(
    'P7c reopen → partial again',
    data(reopened)?.status === 'partial',
    reopened.body,
  );
  const untouched = await order([{ itemId: itemB.id, quantity: 2 }]);
  const closeUntouched = await req(
    'POST',
    `/sales-orders/${untouched.id}/close`,
    {},
  );
  ok(
    'P7d an untouched order is cancelled, not closed',
    errCode(closeUntouched) === 'SO_NOTHING_TO_CLOSE',
    closeUntouched.body,
  );

  // ── P8 one-step, then void ─────────────────────────────────────────────────
  console.log('\nP8. One-step convert of an untouched order, then void');
  const startB = await onHand(itemB.id);
  const oneStep = data(await convert(untouched.id));
  d = await detail(untouched.id);
  ok(
    'P8a bills everything and records it shipped',
    n(oneStep?.invoice?.lines?.[0]?.quantity) === 2 &&
      d.status === 'invoiced' &&
      n(d.totals?.shipped) === 2,
    { status: d.status, totals: d.totals },
  );
  ok('P8b stock moved by 2', (await onHand(itemB.id)) === startB - 2);
  await req('POST', `/invoices/${oneStep.invoice.id}/void`, { reason: 'test' });
  d = await detail(untouched.id);
  ok(
    'P8c void → open, nothing shipped, nothing left in exposure',
    d.status === 'open' &&
      n(d.totals?.shipped) === 0 &&
      n(d.totals?.invoiced) === 0,
    { status: d.status, totals: d.totals },
  );
  ok('P8d stock restored', (await onHand(itemB.id)) === startB);

  // ── P9 the reported case: invoiced in full, 4 of 10 delivered ──────────────
  console.log('\nP9. Old order invoiced in full with 4 of 10 shipped');
  const itemC = await newItem('C', 0);
  const legacy = await order([{ itemId: itemC.id, quantity: 10 }]);
  await sql(
    `UPDATE sales_order_line_items SET quantity_fulfilled = 4, quantity_invoiced = 10 WHERE sales_order_id = $1`,
    [legacy.id],
  );
  await sql(`UPDATE sales_orders SET status = 'invoiced' WHERE id = $1`, [
    legacy.id,
  ]);
  d = await detail(legacy.id);
  ok(
    'P9a Record shipment is offered for the 6 not delivered',
    d.actions?.ship === true &&
      n(d.totals?.toShip) === 6 &&
      n(d.totals?.billedNotShipped) === 6,
    { actions: d.actions, totals: d.totals },
  );
  const rest = await ship(d, [10]);
  d = await detail(legacy.id);
  ok(
    'P9b the rest ships with no stock on hand (already off the books) and stays invoiced',
    rest.status === 200 &&
      d.status === 'invoiced' &&
      n(d.totals?.toShip) === 0 &&
      d.actions?.ship === false,
    rest.body,
  );

  // ── P10 staff request staleness ────────────────────────────────────────────
  console.log('\nP10. A staff invoice request bills what the owner reviewed');
  const staffUser = `sop.staff.${RUN}`.toLowerCase();
  const staff = await req('POST', '/settings/users', {
    name: 'SOP Staff',
    username: staffUser,
    password: 'Test1234!',
    role: 'staff',
  });
  if (staff.status === 200 || staff.status === 201) {
    const ST = data(
      await req(
        'POST',
        '/auth/signin',
        { email: staffUser, password: 'Test1234!' },
        '',
      ),
    )?.tokens?.accessToken;
    const itemD = await newItem('D', 50);
    so = await order([{ itemId: itemD.id, quantity: 10 }]);
    await ship(so, [5]);
    const asked = data(await convert(so.id, {}, ST));
    ok(
      'P10a staff conversion is filed for approval',
      asked?.pending === true && !!asked?.requestId,
      asked,
    );
    // The order changes before the owner decides: the shipment is lowered.
    await ship(so, [3]);
    const stale = await req('POST', `/approvals/${asked?.requestId}/decide`, {
      decision: 'approve',
    });
    ok(
      'P10b approving a request the order outgrew is refused',
      errCode(stale) === 'SO_CHANGED_SINCE_REQUEST',
      stale.body,
    );
    const asked2 = data(await convert(so.id, {}, ST));
    const fresh = await req('POST', `/approvals/${asked2?.requestId}/decide`, {
      decision: 'approve',
    });
    d = await detail(so.id);
    ok(
      'P10c a fresh request approves and bills exactly 3',
      fresh.status === 200 &&
        n(d.totals?.invoiced) === 3 &&
        d.status === 'partial',
      { body: fresh.body, totals: d.totals },
    );
  } else {
    ok('P10 staff user created', false, staff.body);
  }

  // ── P11 fixed discount shared out ──────────────────────────────────────────
  console.log('\nP11. A fixed discount adds up across invoices');
  const itemE = await newItem('E', 50);
  so = await order([{ itemId: itemE.id, quantity: 3 }], {
    discountType: 'amount',
    discountValue: '100',
  });
  const discounts: number[] = [];
  for (const shipped of [1, 2, 3]) {
    await ship(so, [shipped]);
    const r = data(await convert(so.id));
    discounts.push(n(r?.invoice?.discountAmount));
  }
  ok(
    'P11 33.33 + 33.33 + 33.34 = 100',
    near(discounts[0], 33.33) &&
      near(discounts[2], 33.34) &&
      near(
        discounts.reduce((a, b) => a + b, 0),
        100,
      ),
    discounts,
  );

  // ── P12 cancel / delete guards ─────────────────────────────────────────────
  console.log('\nP12. Cancel / delete once goods shipped or were invoiced');
  const itemF = await newItem('F', 50);
  so = await order([{ itemId: itemF.id, quantity: 10 }]);
  await ship(so, [5]);
  const cancelShipped = await req('POST', `/sales-orders/${so.id}/cancel`);
  ok(
    'P12a cancel with shipments is refused',
    errCode(cancelShipped) === 'SO_HAS_SHIPMENTS',
    cancelShipped.body,
  );
  await convert(so.id);
  const cancelInvoiced = await req('POST', `/sales-orders/${so.id}/cancel`);
  ok(
    'P12b cancel with an invoice is refused',
    errCode(cancelInvoiced) === 'SO_HAS_INVOICES',
    cancelInvoiced.body,
  );
  const del = await req('DELETE', `/sales-orders/${so.id}`);
  ok(
    'P12c delete with an invoice is refused',
    errCode(del) === 'CANNOT_DELETE',
    del.body,
  );

  // ── P13 physical availability ──────────────────────────────────────────────
  console.log('\nP13. Shipping is limited by what is on the shelf');
  const itemG = await newItem('G', 10);
  const first = await order([{ itemId: itemG.id, quantity: 8 }]);
  await ship(first, [8]);
  const second = await order([{ itemId: itemG.id, quantity: 5 }]);
  const tooMuch = await ship(second, [5]);
  ok(
    'P13 8 shipped (not invoiced) of 10 → only 2 can ship elsewhere',
    errCode(tooMuch) === 'INSUFFICIENT_STOCK',
    tooMuch.body,
  );
  const fits = await ship(second, [2]);
  ok('P13b 2 still ships', fits.status === 200, fits.body);

  await db.end();
  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
