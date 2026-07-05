/**
 * MetroMatrix demo invariants (phase5 Task 2 check).
 *
 * Asserts, against a running API, that the demo company's books tie out:
 *   • Trial Balance: total debits = total credits
 *   • Balance Sheet: Assets = Liabilities + Equity
 *   • Balance Sheet Inventory (1200) = Inventory Valuation total
 *   • Balance Sheet AR (1100) = A/R Aging total
 *   • Balance Sheet AP (2000) = A/P Aging total
 *   • GRNI (2050) = 0
 *
 * With LIVE_CHECK=1 it additionally creates a realistic invoice + full
 * payment on the demo company (indistinguishable from seeded activity) and
 * re-asserts every invariant — proving the demo behaves as a live app, not
 * a frozen snapshot.
 *
 * Usage:
 *   BASE_URL=https://.../api/v1 [LIVE_CHECK=1] npm run verify:demo
 * Defaults: prod URL + metromatrix@gmail.com / 123456.
 */
export {};

const BASE = process.env.BASE_URL || 'https://finmatrix-api-prod-665c6b5cb6a1.herokuapp.com/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'metromatrix@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const LIVE_CHECK = process.env.LIVE_CHECK === '1';
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0;
let fail = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, extra?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${extra !== undefined ? ' :: ' + JSON.stringify(extra) : ''}`); }
}
const close = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;

async function req(method: string, path: string, token?: string, cid?: string, json?: any) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (cid) headers['x-company-id'] = cid;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`${BASE}${path}`, { method, headers, body: json !== undefined ? JSON.stringify(json) : undefined });
  let body: any = null;
  try { body = await r.json(); } catch { /* empty */ }
  return { status: r.status, body };
}

async function main() {
  console.log(`\n=== MetroMatrix demo invariants @ ${BASE} ===\n`);
  const login = await req('POST', '/auth/signin', undefined, undefined, { email: ADMIN_EMAIL, password: ADMIN_PASSWORD });
  const token = login.body?.data?.tokens?.accessToken;
  const cid = login.body?.data?.companyId;
  check('admin signs in', !!token && !!cid, login.status);

  const bsLine = (bs: any, code: string): number => {
    for (const sect of ['assets', 'liabilities', 'equity']) {
      const row = (bs?.[sect] ?? []).find((x: any) => x.accountCode === code);
      if (row) return Number(row.amount);
    }
    return 0;
  };

  const assertAll = async (label: string) => {
    const tb = (await req('GET', `/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31`, token, cid)).body;
    const bs = (await req('GET', `/reports/balance-sheet?asOfDate=${TODAY}`, token, cid)).body;
    const val = (await req('GET', `/reports/inventory-valuation`, token, cid)).body;
    const ar = (await req('GET', `/reports/ar-aging`, token, cid)).body;
    const ap = (await req('GET', `/reports/ap-aging`, token, cid)).body;
    const arTotal = (ar?.rows ?? []).reduce((a: number, x: any) => a + Number(x.total ?? 0), 0);
    const apTotal = (ap?.rows ?? []).reduce((a: number, x: any) => a + Number(x.total ?? 0), 0);

    check(`${label}: TB balanced (Dr ${tb?.totalDebits} = Cr ${tb?.totalCredits})`,
      tb?.isBalanced === true && close(Number(tb?.totalDebits), Number(tb?.totalCredits)), tb);
    check(`${label}: BS balanced (A = L + E)`,
      bs?.isBalanced === true && close(Number(bs?.totalAssets), Number(bs?.totalLiabilities) + Number(bs?.totalEquity)),
      { a: bs?.totalAssets, l: bs?.totalLiabilities, e: bs?.totalEquity });
    check(`${label}: BS Inventory = Valuation (${bsLine(bs, '1200')} = ${val?.totalValue})`,
      close(bsLine(bs, '1200'), Number(val?.totalValue)));
    check(`${label}: BS AR = A/R aging (${bsLine(bs, '1100')} = ${Math.round(arTotal * 100) / 100})`,
      close(bsLine(bs, '1100'), arTotal));
    check(`${label}: BS AP = A/P aging (${bsLine(bs, '2000')} = ${Math.round(apTotal * 100) / 100})`,
      close(bsLine(bs, '2000'), apTotal));
    check(`${label}: GRNI nets to 0`, close(bsLine(bs, '2050'), 0));
  };

  await assertAll('seeded');

  if (LIVE_CHECK) {
    console.log('\n— Live action: invoice + full payment (behaves as a live app)');
    const customers = (await req('GET', '/customers?limit=5', token, cid)).body?.data;
    const customer = (customers?.data ?? customers ?? [])[0];
    const itemsRes = (await req('GET', '/inventory/items?limit=10', token, cid)).body?.data;
    const itemRows: any[] = itemsRes?.items ?? itemsRes?.data ?? (Array.isArray(itemsRes) ? itemsRes : []);
    const item = itemRows.find((i: any) => Number(i.quantityOnHand) >= 2);
    check('live-check prerequisites (customer + stocked item)', !!customer?.id && !!item?.id, { customer: customer?.id, item: item?.id });

    const inv = (await req('POST', '/invoices', token, cid, {
      customerId: customer.id, invoiceDate: TODAY, dueDate: TODAY, status: 'sent',
      lines: [{ description: item.name, quantity: '2', unitPrice: String(item.sellingPrice), taxRate: '17', itemId: item.id }],
    })).body?.data;
    check('live invoice posted', !!inv?.id, inv);
    const pay = await req('POST', '/payments', token, cid, {
      customerId: customer.id, paymentDate: TODAY, paymentMethod: 'cash',
      amount: String(inv.total), applications: [{ invoiceId: inv.id, amount: String(inv.total) }],
    });
    check('live payment posted', pay.status === 201 || pay.status === 200, pay.body);

    await assertAll('after live invoice + payment');
  }

  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fails.length) fails.forEach(f => console.log(`  - ${f}`));
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });
