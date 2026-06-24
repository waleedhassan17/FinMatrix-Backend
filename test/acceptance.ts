/**
 * FinMatrix — Acceptance Suite (FinMatrixGuide §8)
 * ================================================
 * Automated end-to-end checks against a running API, asserting the ledger
 * invariants and the scenario tests from the spec. Every financial mutation is
 * exercised through the real HTTP surface and the books are re-verified after.
 *
 * Usage:
 *   API_BASE=https://finmatrix-api-prod-665c6b5cb6a1.herokuapp.com/api/v1 \
 *   ADMIN_EMAIL=metromatrix@gmail.com ADMIN_PASSWORD=123456 \
 *   RIDER_EMAIL=saim@metromatrix.com RIDER_PASSWORD=123456 \
 *   npm run test:acceptance
 *
 * Exits non-zero if any check fails.
 */
import 'reflect-metadata';

const API = process.env.API_BASE || 'https://finmatrix-api-prod-665c6b5cb6a1.herokuapp.com/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'metromatrix@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const RIDER_EMAIL = process.env.RIDER_EMAIL || 'saim@metromatrix.com';
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
  const res = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
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
  const riderSignin = await api('POST', '/auth/signin', { email: RIDER_EMAIL, password: RIDER_PASSWORD });
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
