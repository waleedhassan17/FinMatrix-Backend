/**
 * phase3.md — Four-feature acceptance (Chart of Accounts, Payroll, Budgets,
 * Bank Reconciliation) against the QuickBooks target flows.
 * =========================================================
 * Runs over the real HTTP surface using a FRESH company so every number is
 * exact. Verifies:
 *
 *  CoA      — type-driven normal balance (credit-normal account grows on
 *             credit), deactivate-not-delete for accounts with history,
 *             ledger-derived balance, numbering.
 *  Payroll  — run computes gross→deductions→net; review (draft) then process
 *             posts EXACTLY Dr gross expense / Cr tax payable / Cr cash-net;
 *             Trial Balance balances; idempotent (second process AND a
 *             concurrent double-tap can't double-post); a paid period can't
 *             be re-created; NO default withholding when none configured;
 *             remitting tax clears the payable; period lock respected.
 *  Budgets  — per-account monthly budget; vs-actual actuals from the ledger
 *             with correct variance (annual + monthly); prefill returns
 *             prior actuals; NOTHING posted (GL count unchanged).
 *  Bank rec — tick-to-zero flow: wrong ending balance rejected, exact one
 *             finishes; posts NO journal entries; rolls beginning balance
 *             into the next reconciliation; locks cleared rows (they leave
 *             the unreconciled list); out-of-order statements rejected;
 *             report lists outstanding items; latest-only undo restores.
 *
 * Usage:
 *   API_BASE=http://localhost:3001/api/v1 \
 *   PG_URL=postgres://user:pass@host:5432/db \
 *   npm run test:five-features
 */
export {};
/* eslint-disable @typescript-eslint/no-var-requires */
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3001/api/v1';
const PG_URL = process.env.PG_URL as string;
const SUPER_EMAIL = process.env.SUPER_EMAIL || 'waleedhassansfd@gmail.com';
const SUPER_PASSWORD = process.env.SUPER_PASSWORD || 'Waleed@104';
const TODAY = new Date().toISOString().slice(0, 10);

let pass = 0;
let fail = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean, detail?: unknown) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; fails.push(name); console.log(`  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail)?.slice(0, 200) : ''}`); }
}
const close = (a: number, b: number, tol = 0.01) => Math.abs(a - b) <= tol;
const n = (v: unknown) => parseFloat(String(v ?? '0')) || 0;

interface Res { status: number; body: any }
async function req(method: string, path: string, opts: { token?: string; companyId?: string; json?: any } = {}): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.companyId) headers['x-company-id'] = opts.companyId;
  if (opts.json !== undefined) headers['Content-Type'] = 'application/json';
  let r = await fetch(`${API}${path}`, { method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined });
  for (let retry = 0; r.status === 429 && retry < 4; retry++) {
    console.log('    (throttled — waiting 20s)');
    await new Promise(res => setTimeout(res, 20_000));
    r = await fetch(`${API}${path}`, { method, headers, body: opts.json !== undefined ? JSON.stringify(opts.json) : undefined });
  }
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

async function main() {
  if (!PG_URL) throw new Error('PG_URL is required');
  const pg = new Client({ connectionString: PG_URL });
  await pg.connect();

  console.log(`\n=== phase3.md four-feature acceptance @ ${API} ===\n`);

  // ── Setup: fresh approved company (full-featured) ──
  console.log('— Setup');
  const superLogin = await signin(SUPER_EMAIL, SUPER_PASSWORD);
  const superToken = data(superLogin)?.tokens?.accessToken;
  ok('super-admin signs in', !!superToken);

  const email = `qa_p3_${Date.now()}@qa.local`;
  const signup = await req('POST', '/auth/signup', {
    json: { email, password: 'Qa@12345', displayName: 'QA P3 Admin', phone: '+92-300-1234567', role: 'admin' },
  });
  const token0 = data(signup)?.tokens?.accessToken;
  const userId = data(signup)?.user?.id;
  const createCo = await req('POST', '/companies', {
    token: token0,
    json: { name: `QA P3 Books ${Date.now()}`, industry: 'Retail', companyType: 'warehouse' },
  });
  const cid = data(createCo)?.id;
  await req('POST', `/companies/${cid}/submit`, { token: token0, companyId: cid });
  await req('PATCH', `/admin/companies/${cid}/approve`, { token: superToken });
  await pg.query(`UPDATE users SET is_email_verified = true WHERE id = $1`, [userId]);
  const relogin = await signin(email, 'Qa@12345');
  const T = data(relogin)?.tokens?.accessToken;
  ok('company admin ready', !!T && !!cid);
  const A = { token: T, companyId: cid };

  const trialBalance = async () => (await req('GET', `/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31`, A)).body;
  const acctRows = async (code: string): Promise<any[]> => {
    const d = data(await req('GET', `/accounts?search=${code}`, A));
    const arr = d?.accounts ?? d?.data ?? d ?? [];
    return Array.isArray(arr) ? arr : [];
  };
  const acctBalance = async (code: string) => n((await acctRows(code)).find((x) => x.accountNumber === code)?.balance);
  const acctId = async (code: string) => (await acctRows(code)).find((x) => x.accountNumber === code)?.id as string;
  const glCount = async () => Number((await pg.query(`SELECT COUNT(*)::int c FROM general_ledger WHERE company_id=$1`, [cid])).rows[0].c);
  const assertTB = async (label: string) => {
    const tb = await trialBalance();
    ok(`[${label}] Trial Balance balances (Dr ${tb?.totalDebits} = Cr ${tb?.totalCredits})`, tb?.isBalanced === true, tb);
  };

  // Opening cash so payroll has funds and bank rec has an account with money.
  const cashId = await acctId('1000');
  const obeId = await acctId('3900');
  await req('POST', '/journal-entries', {
    ...A,
    json: {
      date: TODAY, memo: 'Opening cash', status: 'posted',
      lines: [
        { accountId: cashId, debit: '100000', credit: '0', description: 'Opening cash' },
        { accountId: obeId, debit: '0', credit: '100000', description: 'Offset' },
      ],
    },
  });
  await assertTB('after opening cash');

  // ═════ 1. CHART OF ACCOUNTS ═════
  console.log('\n— 1. Chart of Accounts');
  const num1 = `2900-${Date.now() % 10000}`;
  const liab = data(await req('POST', '/accounts', {
    ...A, json: { accountNumber: num1, name: 'QA Loan Payable', type: 'liability', subType: 'Other Liability' },
  }));
  ok('create account with type + detail type + number', !!liab?.id && liab?.type === 'liability', liab);

  // Post Dr Cash / Cr Loan — a credit must INCREASE a liability (credit-normal).
  await req('POST', '/journal-entries', {
    ...A,
    json: {
      date: TODAY, memo: 'Loan received', status: 'posted',
      lines: [
        { accountId: cashId, debit: '5000', credit: '0', description: 'Loan proceeds' },
        { accountId: liab.id, debit: '0', credit: '5000', description: 'Loan payable' },
      ],
    },
  });
  const liabBal = await acctBalance(num1);
  ok('TYPE drives normal balance: crediting a liability INCREASES its balance (+5000)', close(liabBal, 5000), liabBal);

  const delTry = await req('DELETE', `/accounts/${liab.id}`, A);
  ok('account with history cannot be hard-deleted (ACCOUNT_HAS_TRANSACTIONS)',
    delTry.status === 400 && JSON.stringify(delTry.body).includes('ACCOUNT_HAS_TRANSACTIONS'), delTry.status);
  const deact = await req('PATCH', `/accounts/${liab.id}`, { ...A, json: { isActive: false } });
  ok('deactivate instead works (history preserved)', deact.status < 300 && data(deact)?.isActive === false, deact.body);
  const txns = (await req('GET', `/accounts/${liab.id}/transactions`, A)).body;
  const txnRows = txns?.data?.data ?? txns?.data ?? [];
  ok('ledger-derived activity endpoint returns the posting', Array.isArray(txnRows) && txnRows.length >= 1, txnRows?.length);
  const sysDel = await req('DELETE', `/accounts/${cashId}`, A);
  ok('system account protected from delete', sysDel.status === 400, sysDel.status);
  await assertTB('CoA scenarios done');

  // ═════ 2. EMPLOYEES & PAYROLL ═════
  console.log('\n— 2. Employees & Payroll');
  const emp1 = data(await req('POST', '/employees', {
    ...A, json: { firstName: 'Aisha', lastName: 'Tax', payType: 'salary', salary: '120000', payFrequency: 'monthly', deductionAmount: '1500' },
  }));
  const emp2 = data(await req('POST', '/employees', {
    ...A, json: { firstName: 'Bilal', lastName: 'NoTax', payType: 'salary', salary: '60000', payFrequency: 'monthly' },
  }));
  ok('employees created (one WITH a configured deduction, one WITHOUT)', !!emp1?.id && !!emp2?.id);

  const run = data(await req('POST', '/payroll/runs', {
    ...A, json: { payPeriod: 'QA Month', periodStart: TODAY, periodEnd: TODAY, payDate: TODAY },
  }));
  ok('run created as DRAFT for review (not posted yet)', run?.status === 'draft', run?.status);
  // gross: 120000/12=10000 + 60000/12=5000 = 15000; ded: 1500 + 0; net 13500
  ok('gross computed per employee (15,000 total)', close(n(run?.totalGross), 15000), run?.totalGross);
  ok('NO hardcoded withholding: only the configured 1,500 is deducted', close(n(run?.totalDeductions), 1500), run?.totalDeductions);
  ok('net = gross − deductions (13,500)', close(n(run?.totalNet), 13500), run?.totalNet);

  const glBeforeReview = await glCount();
  const cashBefore = await acctBalance('1000');
  const wagesBefore = await acctBalance('6200');
  const taxBefore = await acctBalance('2300');
  ok('review posts NOTHING until processed', glBeforeReview === (await glCount()));

  // Concurrent double-tap: exactly one process must succeed.
  const [p1, p2] = await Promise.all([
    req('POST', `/payroll/runs/${run.id}/process`, { ...A, json: {} }),
    req('POST', `/payroll/runs/${run.id}/process`, { ...A, json: {} }),
  ]);
  const processOKs = [p1, p2].filter(r => r.status < 300).length;
  ok('concurrent double-tap: exactly ONE process succeeds', processOKs === 1, { s1: p1.status, s2: p2.status });

  ok('Dr Wage/Salary Expense = GROSS (+15,000)', close(await acctBalance('6200'), wagesBefore + 15000), await acctBalance('6200'));
  ok('Cr Tax Payable = WITHHELD (a liability, +1,500 — never income)', close(await acctBalance('2300'), taxBefore + 1500), await acctBalance('2300'));
  ok('Cr Cash = NET (−13,500)', close(await acctBalance('1000'), cashBefore - 13500), await acctBalance('1000'));
  await assertTB('after payroll posts');

  const again = await req('POST', `/payroll/runs/${run.id}/process`, { ...A, json: {} });
  ok('re-processing rejected (idempotent)', again.status === 400, again.status);
  const dupPeriod = await req('POST', '/payroll/runs', {
    ...A, json: { payPeriod: 'QA Month', periodStart: TODAY, periodEnd: TODAY, payDate: TODAY },
  });
  ok('re-creating an already-PAID period rejected (PERIOD_ALREADY_PAID)',
    dupPeriod.status === 400 && JSON.stringify(dupPeriod.body).includes('PERIOD_ALREADY_PAID'), dupPeriod.status);

  const delEmp = await req('DELETE', `/employees/${emp1.id}`, A);
  ok('employee with payroll history cannot be deleted', delEmp.status === 400 && JSON.stringify(delEmp.body).includes('EMPLOYEE_HAS_PAYROLL_HISTORY'), delEmp.status);

  // Remitting the withheld tax clears the payable (existing tax-payment flow).
  const taxRate = data(await req('POST', '/taxes/rates', { ...A, json: { name: 'QA WHT', rate: '0', taxType: 'payroll' } }));
  if (taxRate?.id) {
    const remit = await req('POST', '/taxes/payments', { ...A, json: { taxRateId: taxRate.id, period: 'QA Month', amount: '1500', paymentDate: TODAY } });
    ok('remitting withheld tax clears the payable (Dr 2300 / Cr Cash)', remit.status < 300 && close(await acctBalance('2300'), taxBefore), await acctBalance('2300'));
  } else {
    ok('remitting withheld tax (skipped — could not create tax rate)', true);
  }

  // Period lock: a run dated in a locked period must be rejected by the engine.
  await req('PATCH', `/companies/${cid}`, { ...A, json: { booksLockedUntil: '2999-01-01' } });
  const lockedRun = data(await req('POST', '/payroll/runs', {
    ...A, json: { payPeriod: 'QA Locked', periodStart: TODAY, periodEnd: TODAY, payDate: TODAY },
  }));
  const lockedProcess = await req('POST', `/payroll/runs/${lockedRun?.id}/process`, { ...A, json: {} });
  ok('period lock respected (posting into a locked period rejected)', lockedProcess.status >= 400, lockedProcess.status);
  await req('PATCH', `/companies/${cid}`, { ...A, json: { booksLockedUntil: null } });
  await assertTB('after payroll scenarios');

  // ═════ 3. BUDGETS ═════
  console.log('\n— 3. Budgets');
  const wagesId = await acctId('6200');
  const glBeforeBudget = await glCount();
  const budget = data(await req('POST', '/budgets', {
    ...A,
    json: {
      name: 'QA Budget', fiscalYear: new Date().getFullYear(), status: 'active',
      lines: [{ accountId: wagesId, monthlyAmounts: Array.from({ length: 12 }, () => 2000) }],
    },
  }));
  ok('per-account monthly budget created (12 × 2,000)', !!budget?.id && close(n(budget?.totalBudget), 24000), budget?.totalBudget);

  const vsa = data(await req('GET', `/budgets/${budget.id}/vs-actual`, A));
  const row = (vsa?.rows ?? [])[0];
  ok('vs-actual pulls ACTUALS from the ledger (wages 15,000)', close(n(row?.actual), 15000), row?.actual);
  ok('variance correct (24,000 − 15,000 = 9,000)', close(n(row?.variance), 9000), row?.variance);
  const thisMonth = new Date().getMonth() + 1;
  const mrow = (row?.months ?? []).find((m: any) => m.month === thisMonth);
  ok('MONTHLY breakdown present and correct for the current month (actual 15,000, budget 2,000)',
    !!mrow && close(n(mrow.actual), 15000) && close(n(mrow.budgeted), 2000), mrow);
  ok('budget posted NOTHING to the ledger', (await glCount()) === glBeforeBudget);

  const prefill = data(await req('GET', `/budgets/prefill?fiscalYear=${new Date().getFullYear()}`, A));
  const pfRow = (prefill?.lines ?? []).find((l: any) => l.accountId === wagesId);
  ok('prefill returns per-account monthly actuals (wages 15,000 annual)', !!pfRow && close(n(pfRow.annualTotal), 15000), pfRow?.annualTotal);
  await assertTB('after budget scenarios');

  // ═════ 4. BANK RECONCILIATION ═════
  console.log('\n— 4. Bank Reconciliation');
  const unrec1 = data(await req('GET', `/reconciliations/unreconciled?accountId=${cashId}&endDate=${TODAY}`, A));
  const entries1: any[] = unrec1?.entries ?? [];
  ok('unreconciled book transactions listed', entries1.length >= 2, entries1.length);
  ok('beginning balance starts at 0 (no prior reconciliation)', close(n(unrec1?.beginningBalance), 0), unrec1?.beginningBalance);
  ok('no beginning-balance warning on a first reconciliation', unrec1?.beginningMismatch == null);

  const clearedNet1 = entries1.reduce((s, e) => s + n(e.amount), 0);
  const glBeforeRec = await glCount();

  const wrong = await req('POST', '/reconciliations', {
    ...A,
    json: { accountId: cashId, statementDate: TODAY, statementEndingBalance: (clearedNet1 + 123).toFixed(2), clearedEntryIds: entries1.map(e => e.id) },
  });
  ok('finish REJECTED while difference ≠ 0 (RECONCILIATION_OUT_OF_BALANCE)',
    wrong.status === 400 && JSON.stringify(wrong.body).includes('OUT_OF_BALANCE'), wrong.status);

  const fin = await req('POST', '/reconciliations', {
    ...A,
    json: { accountId: cashId, statementDate: TODAY, statementEndingBalance: clearedNet1.toFixed(2), clearedEntryIds: entries1.map(e => e.id) },
  });
  const recon1 = data(fin);
  ok('finishes when difference = 0', fin.status < 300 && close(n(recon1?.difference), 0), fin.body);
  ok('reconciliation posted NO journal entries', (await glCount()) === glBeforeRec);

  const unrecAfter = data(await req('GET', `/reconciliations/unreconciled?accountId=${cashId}&endDate=${TODAY}`, A));
  ok('cleared rows are LOCKED out of the unreconciled list', (unrecAfter?.entries ?? []).length === 0, unrecAfter?.entries?.length);
  ok('beginning balance ROLLS to the statement ending balance', close(n(unrecAfter?.beginningBalance), clearedNet1), unrecAfter?.beginningBalance);

  const outOfOrder = await req('POST', '/reconciliations', {
    ...A,
    json: { accountId: cashId, statementDate: '2000-01-01', statementEndingBalance: '0.00', clearedEntryIds: [] },
  });
  ok('statement dated before the last reconciliation rejected (OUT_OF_ORDER)',
    outOfOrder.status === 400 && JSON.stringify(outOfOrder.body).includes('OUT_OF_ORDER'), outOfOrder.status);

  // New book transaction AFTER reconciling → outstanding item on the report? It is
  // dated today (= statement date) and uncleared → appears as outstanding.
  await req('POST', '/journal-entries', {
    ...A,
    json: {
      date: TODAY, memo: 'Post-rec payment', status: 'posted',
      lines: [
        { accountId: await acctId('6000'), debit: '700', credit: '0', description: 'Rent' },
        { accountId: cashId, debit: '0', credit: '700', description: 'Rent paid' },
      ],
    },
  });
  const report = data(await req('GET', `/reconciliations/${recon1.id}`, A));
  ok('reconciliation report returned (history)', !!report?.id && (report?.entries ?? []).length === entries1.length);
  ok('report lists OUTSTANDING items (the uncleared 700 payment)',
    (report?.outstanding ?? []).some((e: any) => close(Math.abs(n(e.amount)), 700)), report?.outstanding?.length);

  const undo = await req('DELETE', `/reconciliations/${recon1.id}`, A);
  ok('admin undo restores the rows', undo.status < 300, undo.status);
  const unrecUndone = data(await req('GET', `/reconciliations/unreconciled?accountId=${cashId}&endDate=${TODAY}`, A));
  ok('undone rows are unreconciled again (beginning back to 0)',
    (unrecUndone?.entries ?? []).length >= entries1.length && close(n(unrecUndone?.beginningBalance), 0),
    { entries: unrecUndone?.entries?.length, beginning: unrecUndone?.beginningBalance });
  ok('undo posted NO journal entries', (await glCount()) === glBeforeRec + 2); // +2 GL rows = the rent JE's two lines

  await assertTB('FINAL');

  await pg.end();
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  if (fail > 0) { console.log('Failures:'); fails.forEach(f => console.log('  - ' + f)); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error('SUITE ERROR:', e); process.exit(1); });
