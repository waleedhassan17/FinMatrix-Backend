/**
 * FinMatrix QA scenario (audit gap G5).
 *
 * Drives one company through the full accounting cycle against a running API,
 * so the invariants afterwards are checked against books that actually contain
 * every document type rather than a quiet dataset.
 *
 * Deterministic in shape, not in identifiers: references carry a run suffix so
 * the scenario can be replayed against the same database without colliding on
 * unique numbers. Amounts are fixed, so the expected ledger movement below is
 * exact.
 *
 *   purchase order -> receipt -> vendor bill -> bill payment
 *   invoice -> customer payment
 *   credit memo (with tax + restock)
 *   vendor credit (with input tax)
 *   inventory adjustment
 *   tax payment
 *   manual journal entry
 *
 * Usage:
 *   API_BASE=http://localhost:3000/api/v1 npx ts-node -r tsconfig-paths/register qa/seed-scenario.ts
 */
export {};

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const EMAIL = process.env.WH_EMAIL || 'warehouse@gmail.com';
const PASSWORD = process.env.WH_PASSWORD || '123456';
const TODAY = new Date().toISOString().slice(0, 10);
const RUN = Date.now().toString().slice(-8);

let TOKEN = '';
let COMPANY = '';
let steps = 0;

async function req(method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (TOKEN) headers.Authorization = `Bearer ${TOKEN}`;
  if (COMPANY) headers['x-company-id'] = COMPANY;
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try {
    parsed = await res.json();
  } catch {
    /* empty */
  }
  return { status: res.status, body: parsed };
}
const data = (r: { body: any }) => r.body?.data ?? r.body;

function step(label: string, res: { status: number; body: any }) {
  const okish = res.status >= 200 && res.status < 300;
  steps++;
  console.log(`  ${okish ? '·' : '!'} ${label}${okish ? '' : ` (${res.status} ${JSON.stringify(res.body)?.slice(0, 160)})`}`);
  if (!okish) throw new Error(`scenario step failed: ${label}`);
  return data(res);
}

async function main() {
  console.log(`\nFinMatrix QA scenario → ${API}\n`);

  const login = await req('POST', '/auth/signin', { email: EMAIL, password: PASSWORD });
  TOKEN = data(login)?.tokens?.accessToken ?? '';
  COMPANY = data(login)?.companyId ?? '';
  if (!TOKEN) throw new Error(`cannot sign in as ${EMAIL}`);
  console.log(`  · signed in, company ${COMPANY}`);

  // Start from open books whatever a previous run left behind.
  await req('POST', `/companies/${COMPANY}/period-reopen`);

  const customer = step(
    'customer',
    await req('POST', '/customers', {
      name: `QA Customer ${RUN}`,
      email: `qa.customer.${RUN}@example.test`,
    }),
  );
  const vendor = step(
    'vendor',
    await req('POST', '/vendors', { companyName: `QA Vendor ${RUN}` }),
  );
  const item = step(
    'inventory item',
    await req('POST', '/inventory/items', {
      sku: `QA-${RUN}`,
      name: `QA Widget ${RUN}`,
      unitOfMeasure: 'unit',
      costMethod: 'average',
      unitCost: '0',
      sellingPrice: '250',
    }),
  );

  // ── Purchase cycle: PO -> receipt -> bill -> bill payment ──────
  const po = step(
    'purchase order (40 @ 100)',
    await req('POST', '/purchase-orders', {
      vendorId: vendor.id,
      orderDate: TODAY,
      lines: [{ description: 'QA stock', orderedQty: '40', unitCost: '100', itemId: item.id }],
    }),
  );
  step(
    'receipt (Dr Inventory 4000 / Cr GRNI 4000)',
    await req('POST', `/purchase-orders/${po.id}/receive`, {
      lines: [{ lineId: po.lines[0].id, receivedQty: '40' }],
    }),
  );
  const bill = step(
    'vendor bill (GRNI -> AP)',
    await req('POST', `/purchase-orders/${po.id}/create-bill`, {
      billNumber: `QA-BILL-${RUN}`,
      billDate: TODAY,
      dueDate: '2099-12-31',
    }),
  );
  const accountsForPay = ((data(await req('GET', '/accounts?limit=200')) as any)?.accounts
    ?? (data(await req('GET', '/accounts?limit=200')) as any)?.data ?? []) as any[];
  const bankAccount = accountsForPay.find((a: any) => a.accountNumber === '1010')
    ?? accountsForPay.find((a: any) => a.accountNumber === '1000');
  step(
    'bill payment',
    await req('POST', '/bills/pay', {
      vendorId: vendor.id,
      paymentDate: TODAY,
      paymentMethod: 'bank_transfer',
      bankAccountId: bankAccount.id,
      applications: [{ billId: bill.billId, amount: '4000' }],
    }),
  );

  // ── Sales cycle: invoice -> payment ────────────────────────────
  const invoice = step(
    'invoice (10 @ 250 + 17% tax)',
    await req('POST', '/invoices', {
      customerId: customer.id,
      invoiceDate: TODAY,
      dueDate: '2099-12-31',
      status: 'sent',
      lines: [{ description: 'QA sale', quantity: '10', unitPrice: '250', taxRate: '17', itemId: item.id }],
    }),
  );
  step(
    'customer payment (full)',
    await req('POST', '/payments', {
      customerId: customer.id,
      paymentDate: TODAY,
      amount: String(invoice.total ?? '2925'),
      paymentMethod: 'cash',
      applications: [{ invoiceId: invoice.id, amount: String(invoice.total ?? '2925') }],
    }),
  );

  // ── Corrections ────────────────────────────────────────────────
  step(
    'credit memo (2 returned, tax reversed, restocked at cost)',
    await req('POST', '/credit-memos', {
      customerId: customer.id,
      date: TODAY,
      reason: 'QA scenario return',
      lines: [{ description: 'QA return', quantity: '2', unitPrice: '250', taxRate: '17', itemId: item.id }],
    }),
  );
  step(
    'vendor credit (net + recoverable input tax)',
    await req('POST', '/vendor-credits', {
      vendorId: vendor.id,
      date: TODAY,
      reason: 'QA scenario vendor return',
      lines: [{ description: 'QA vendor return', amount: '500', taxRate: '17' }],
    }),
  );
  step(
    'inventory adjustment (shrinkage of 3)',
    await req('POST', `/inventory/items/${item.id}/adjust`, {
      itemId: item.id,
      newQty: '29',
      reason: 'damage',
      notes: 'QA scenario shrinkage',
    }),
  );

  const rate = step(
    'tax rate',
    await req('POST', '/taxes/rates', {
      name: `QA GST ${RUN}`,
      rate: '17',
      taxType: 'sales',
    }),
  );
  step(
    'tax payment (remit 200)',
    await req('POST', '/taxes/payments', {
      taxRateId: rate.id,
      period: TODAY.slice(0, 7),
      amount: '200',
      paymentDate: TODAY,
    }),
  );

  // ── Manual journal entry ───────────────────────────────────────
  const accountsRes = data(await req('GET', '/accounts?limit=200')) as any;
  const accounts = accountsRes?.accounts ?? accountsRes?.data ?? accountsRes ?? [];
  const cash = accounts.find((a: any) => a.accountNumber === '1000');
  const rent = accounts.find((a: any) => a.accountNumber === '6000');
  if (cash && rent) {
    step(
      'manual journal entry (Dr Rent 750 / Cr Cash 750)',
      await req('POST', '/journal-entries', {
        date: TODAY,
        memo: `QA scenario rent ${RUN}`,
        status: 'posted',
        lines: [
          { accountId: rent.id, debit: '750', credit: '0', lineOrder: 0 },
          { accountId: cash.id, debit: '0', credit: '750', lineOrder: 1 },
        ],
      }),
    );
  }

  console.log(`\n${steps} steps completed. Run qa/run-qa.sh to check the invariants.\n`);
}

main().catch((e) => {
  console.error('SCENARIO FAILED:', e.message ?? e);
  process.exit(1);
});
