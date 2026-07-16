/**
 * FinMatrix — Bank Reconciliation Acceptance (bankreconcillation.md PHASE 2)
 * ==========================================================================
 * Runs the QuickBooks reconciliation flow against a REAL server + database,
 * posting real entries. Verifies:
 *
 *   A. post bank txns → reconcile → tick to 0.00 → finish → rows stamped,
 *      report generated, ending balance rolls into the next beginning
 *   B. finish with a NON-ZERO difference → BLOCKED (400)
 *   C. reconciliation posts NOTHING: Trial Balance identical before/after
 *   D. statement-only bank fee (Rs 500) entered as a NORMAL journal entry →
 *      appears in the list → ticking it zeroes the difference
 *   E. unticked txn → outstanding in the report + carries forward
 *   F. reconciled lock: void of a reconciled JE and delete of a reconciled
 *      payment are BLOCKED (TRANSACTION_RECONCILED); unreconciled payment
 *      delete still works and reverses cleanly
 *   G. admin undo: latest-only, restores rows, audit-logged
 *   H. save/resume: PATCH /reconciliations/mark ticks survive a reload
 *   I. Trial Balance + Balance Sheet balanced after EVERY step
 *
 * Usage: boot the server against a throwaway DB, then
 *   API_BASE=http://localhost:3002/api/v1 DATABASE_URL=postgres://... \
 *   npx ts-node -r tsconfig-paths/register test/bankrec.acceptance.ts
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3002/api/v1';
const DB = process.env.DATABASE_URL || '';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed: any = null;
  try { parsed = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: parsed };
}
const data = (r: { body: any }) => r.body?.data ?? r.body;

async function main() {
  const db = new Client({ connectionString: DB });
  await db.connect();

  // ── Bootstrap: demo company, verified + approved ──
  await db.query(`UPDATE users SET is_email_verified = true`);
  await db.query(`UPDATE companies SET status = 'approved'`);

  const signin = await req('POST', '/auth/signin', {
    email: 'admin@finmatrix.pk',
    password: 'Admin123!',
  });
  const tokens = data(signin)?.tokens;
  ok('admin signin', signin.status === 200 && !!tokens?.accessToken, `status=${signin.status}`);
  const companyId = data(signin)?.companyId as string;
  const H = { Authorization: `Bearer ${tokens.accessToken}`, 'x-company-id': companyId };

  // ── Chart of accounts ──
  const acctsRes = await req('GET', '/accounts?limit=200', undefined, H);
  const acctList: any[] = data(acctsRes)?.accounts ?? data(acctsRes) ?? [];
  const byNum = new Map(acctList.map((a: any) => [a.accountNumber, a]));
  const bank = byNum.get('1010') ?? byNum.get('1000');
  const revenue = byNum.get('4000');
  const rent = byNum.get('6000');
  const util = byNum.get('6100') ?? rent;
  ok('COA has bank/revenue/expense accounts', !!bank && !!revenue && !!rent);

  // ── Helpers ──
  const je = async (dateStr: string, memo: string, lines: any[]) => {
    const r = await req('POST', '/journal-entries', { date: dateStr, memo, status: 'posted', lines }, H);
    if (r.status !== 201 && r.status !== 200) throw new Error(`JE failed ${r.status}: ${JSON.stringify(r.body)}`);
    return data(r);
  };
  const trialBalance = async () => {
    const r = await req('GET', '/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31', undefined, H);
    return r.body?.data ?? r.body;
  };
  const balanceSheet = async () => {
    const r = await req('GET', '/reports/balance-sheet?asOfDate=2999-12-31', undefined, H);
    return r.body?.data ?? r.body;
  };
  const booksBalanced = async (label: string) => {
    const tb = await trialBalance();
    const bs = await balanceSheet();
    ok(`${label}: TB balanced (Dr ${tb?.totalDebits} = Cr ${tb?.totalCredits})`, tb?.isBalanced === true);
    ok(`${label}: BS balanced`, bs?.isBalanced === true);
    return tb;
  };
  const unreconciled = async (endDate: string) => {
    const r = await req('GET', `/reconciliations/unreconciled?accountId=${bank.id}&endDate=${endDate}`, undefined, H);
    return data(r);
  };

  // ── A. Post real bank transactions (through the posting engine) ──
  const dep1 = await je('2026-07-01', 'Cash sale banked', [
    { accountId: bank.id, debit: '10000.0000', credit: '0', lineOrder: 0 },
    { accountId: revenue.id, debit: '0', credit: '10000.0000', lineOrder: 1 },
  ]);
  const dep2 = await je('2026-07-03', 'Second deposit', [
    { accountId: bank.id, debit: '4000.0000', credit: '0', lineOrder: 0 },
    { accountId: revenue.id, debit: '0', credit: '4000.0000', lineOrder: 1 },
  ]);
  const pay1 = await je('2026-07-05', 'Rent paid from bank', [
    { accountId: rent.id, debit: '3000.0000', credit: '0', lineOrder: 0 },
    { accountId: bank.id, debit: '0', credit: '3000.0000', lineOrder: 1 },
  ]);
  const pay2 = await je('2026-07-08', 'Utilities paid from bank', [
    { accountId: util.id, debit: '1200.0000', credit: '0', lineOrder: 0 },
    { accountId: bank.id, debit: '0', credit: '1200.0000', lineOrder: 1 },
  ]);
  ok('posted 2 deposits + 2 payments through the ledger', !!dep1?.id && !!dep2?.id && !!pay1?.id && !!pay2?.id);
  await booksBalanced('after posting bank txns');

  // ── First statement: covers dep1, dep2, pay1 — NOT pay2 (outstanding) ──
  const u1 = await unreconciled('2026-07-10');
  ok('beginning balance starts at 0 (never reconciled)', Number(u1?.beginningBalance) === 0, `got ${u1?.beginningBalance}`);
  ok('unreconciled list has the 4 bank rows', (u1?.entries?.length ?? 0) === 4, `got ${u1?.entries?.length}`);
  const rowByMemo = (memo: string) => u1.entries.find((e: any) => (e.memo ?? '').includes(memo));
  const rDep1 = rowByMemo('Cash sale'); const rDep2 = rowByMemo('Second deposit');
  const rPay1 = rowByMemo('Rent'); const rPay2 = rowByMemo('Utilities');
  ok('rows resolved by memo', !!rDep1 && !!rDep2 && !!rPay1 && !!rPay2);

  // ── H. Save/resume: persist ticks, reload, still ticked ──
  const mark = await req('PATCH', '/reconciliations/mark', {
    accountId: bank.id,
    marks: [{ entryId: rDep1.id, cleared: true }, { entryId: rDep2.id, cleared: true }],
  }, H);
  ok('PATCH /reconciliations/mark saves in-progress ticks', mark.status === 200 && data(mark)?.updated === 2, `status=${mark.status} updated=${data(mark)?.updated}`);
  const u1b = await unreconciled('2026-07-10');
  const stillTicked = u1b.entries.filter((e: any) => e.cleared).map((e: any) => e.id).sort();
  ok('save/resume: reload retains the cleared marks', JSON.stringify(stillTicked) === JSON.stringify([rDep1.id, rDep2.id].sort()));

  // ── B. Finish with NON-ZERO difference → blocked ──
  const tbBefore = await trialBalance();
  const badFinish = await req('POST', '/reconciliations', {
    accountId: bank.id,
    statementDate: '2026-07-10',
    statementEndingBalance: '11500.00', // correct is 11000 (10000+4000−3000)
    clearedEntryIds: [rDep1.id, rDep2.id, rPay1.id],
  }, H);
  ok('finish blocked at non-zero difference', badFinish.status === 400 && (badFinish.body?.error?.code ?? badFinish.body?.code) === 'RECONCILIATION_OUT_OF_BALANCE', `status=${badFinish.status}`);

  // ── A. Finish at 0.00 ──
  const fin1 = await req('POST', '/reconciliations', {
    accountId: bank.id,
    statementDate: '2026-07-10',
    statementEndingBalance: '11000.00',
    clearedEntryIds: [rDep1.id, rDep2.id, rPay1.id],
  }, H);
  const recon1 = data(fin1);
  ok('finish at difference 0.00', (fin1.status === 201 || fin1.status === 200) && !!recon1?.id, `status=${fin1.status}`);

  // ── C. Reconciliation posted NOTHING: TB identical to the rupee ──
  const tbAfter = await trialBalance();
  ok(
    'Trial Balance IDENTICAL before/after finish (no JE posted by reconciliation)',
    tbBefore?.totalDebits === tbAfter?.totalDebits && tbBefore?.totalCredits === tbAfter?.totalCredits,
    `before Dr ${tbBefore?.totalDebits} after Dr ${tbAfter?.totalDebits}`,
  );
  await booksBalanced('after first reconciliation');

  // ── E. Report: pay2 is outstanding; rows stamped ──
  const rep1 = await req('GET', `/reconciliations/${recon1.id}`, undefined, H);
  const rep1d = data(rep1);
  ok('report lists 3 cleared entries', rep1d?.entries?.length === 3, `got ${rep1d?.entries?.length}`);
  ok('report lists the unticked txn as outstanding', rep1d?.outstanding?.some((o: any) => o.id === rPay2.id) === true);
  const glStamp = await db.query(`SELECT COUNT(*)::int AS n FROM general_ledger WHERE reconciliation_id = $1`, [recon1.id]);
  ok('3 GL rows stamped reconciled', glStamp.rows[0].n === 3);

  // ── D. Bank fee the books lack, entered as a NORMAL transaction ──
  const fee = await je('2026-07-12', 'Bank service fee', [
    { accountId: rent.id, description: 'Bank charges', debit: '500.0000', credit: '0', lineOrder: 0 },
    { accountId: bank.id, debit: '0', credit: '500.0000', lineOrder: 1 },
  ]);
  ok('bank fee posted as a normal journal entry', !!fee?.id);
  const u2 = await unreconciled('2026-07-15');
  ok('second statement: beginning balance = first statement ending (roll)', Number(u2?.beginningBalance) === 11000, `got ${u2?.beginningBalance}`);
  ok('fee + carried-forward pay2 appear in the list', u2?.entries?.length === 2);
  const rFee = u2.entries.find((e: any) => (e.memo ?? '').includes('fee'));
  const rPay2b = u2.entries.find((e: any) => e.id === rPay2.id);
  ok('outstanding pay2 carried forward into the next session', !!rPay2b);
  const fin2 = await req('POST', '/reconciliations', {
    accountId: bank.id,
    statementDate: '2026-07-15',
    statementEndingBalance: '9300.00', // 11000 − 1200 (pay2) − 500 (fee)
    clearedEntryIds: [rFee.id, rPay2.id],
  }, H);
  const recon2 = data(fin2);
  ok('ticking the fee zeroes the difference → finish OK', (fin2.status === 201 || fin2.status === 200) && !!recon2?.id, `status=${fin2.status}`);
  await booksBalanced('after second reconciliation');

  // ── F. Reconciled lock ──
  const voidRec = await req('POST', `/journal-entries/${dep1.id}/void`, { reason: 'should be blocked' }, H);
  ok('void of a RECONCILED journal entry is blocked', voidRec.status === 400 && (voidRec.body?.error?.code ?? voidRec.body?.code) === 'TRANSACTION_RECONCILED', `status=${voidRec.status}`);

  // Payment flow on the Cash account: reconciled payment delete blocked,
  // unreconciled payment delete works and reverses cleanly.
  const cash = byNum.get('1000');
  const cust = data(await req('POST', '/customers', {
    name: 'Recon Test Customer', email: 'recon@test.pk', phone: '+92-300-1234567',
  }, H));
  const inv = data(await req('POST', '/invoices', {
    customerId: cust.id, invoiceDate: '2026-07-14', dueDate: '2026-07-30',
    status: 'sent', discountType: 'none', discountValue: '0',
    lines: [{ description: 'Consulting', quantity: '1', unitPrice: '2000', taxRate: '0' }],
  }, H));
  const pmt = data(await req('POST', '/payments', {
    customerId: cust.id, paymentDate: '2026-07-14', paymentMethod: 'cash',
    amount: '2000.00', applications: [{ invoiceId: inv.id, amount: '2000.00' }],
  }, H));
  ok('payment received (Dr Cash / Cr AR)', !!pmt?.id);
  const uCash = await req('GET', `/reconciliations/unreconciled?accountId=${cash.id}&endDate=2026-07-15`, undefined, H);
  const cashRow = data(uCash)?.entries?.find((e: any) => e.sourceType === 'payment');
  ok('payment row visible on the Cash account', !!cashRow);
  const finCash = await req('POST', '/reconciliations', {
    accountId: cash.id, statementDate: '2026-07-15',
    statementEndingBalance: data(uCash).entries.reduce((s: number, e: any) => s + Number(e.amount), Number(data(uCash).beginningBalance)).toFixed(2),
    clearedEntryIds: data(uCash).entries.map((e: any) => e.id),
  }, H);
  const reconCash = data(finCash);
  ok('cash account reconciled', (finCash.status === 201 || finCash.status === 200) && !!reconCash?.id, `status=${finCash.status}`);
  const delRec = await req('DELETE', `/payments/${pmt.id}`, undefined, H);
  ok('delete of a RECONCILED payment is blocked', delRec.status === 400 && (delRec.body?.error?.code ?? delRec.body?.code) === 'TRANSACTION_RECONCILED', `status=${delRec.status}`);

  // Unreconciled payment deletes fine and the books stay balanced.
  const inv2 = data(await req('POST', '/invoices', {
    customerId: cust.id, invoiceDate: '2026-07-15', dueDate: '2026-07-30',
    status: 'sent', discountType: 'none', discountValue: '0',
    lines: [{ description: 'Consulting 2', quantity: '1', unitPrice: '1500', taxRate: '0' }],
  }, H));
  const pmt2 = data(await req('POST', '/payments', {
    customerId: cust.id, paymentDate: '2026-07-15', paymentMethod: 'cash',
    amount: '1500.00', applications: [{ invoiceId: inv2.id, amount: '1500.00' }],
  }, H));
  const del2 = await req('DELETE', `/payments/${pmt2.id}`, undefined, H);
  ok('delete of an UNRECONCILED payment works', del2.status === 200 && data(del2)?.deleted === true, `status=${del2.status}`);
  const inv2After = data(await req('GET', `/invoices/${inv2.id}`, undefined, H));
  ok('deleted payment un-applied: invoice unpaid again', Number(inv2After?.amountPaid) === 0 && inv2After?.status !== 'paid', `amountPaid=${inv2After?.amountPaid} status=${inv2After?.status}`);
  await booksBalanced('after payment delete (reversing entry)');

  // ── G. Undo: latest-only + audit-logged ──
  const undoOld = await req('DELETE', `/reconciliations/${recon1.id}`, undefined, H);
  ok('undo of an OLDER reconciliation is blocked', undoOld.status === 400 && (undoOld.body?.error?.code ?? undoOld.body?.code) === 'RECONCILIATION_NOT_LATEST', `status=${undoOld.status}`);
  const undo2 = await req('DELETE', `/reconciliations/${recon2.id}`, undefined, H);
  ok('admin undo of the LATEST reconciliation works', undo2.status === 200 && data(undo2)?.undone === true, `status=${undo2.status}`);
  const freed = await db.query(
    `SELECT COUNT(*)::int AS n FROM general_ledger WHERE company_id=$1 AND account_id=$2 AND reconciliation_id IS NULL AND cleared = false`,
    [companyId, bank.id],
  );
  ok('undo restored the rows (unstamped + untick)', freed.rows[0].n >= 2, `got ${freed.rows[0].n}`);
  const audit = await db.query(
    `SELECT COUNT(*)::int AS n FROM operational_audit_events WHERE company_id=$1 AND action='reconciliation_undone' AND target_id=$2`,
    [companyId, recon2.id],
  );
  ok('undo is audit-logged', audit.rows[0].n === 1);

  // After undo, the fee row is unreconciled again → the JE void lock releases.
  const voidFee = await req('POST', `/journal-entries/${fee.id}/void`, { reason: 'lock released after undo' }, H);
  ok('void allowed again after the reconciliation was undone', voidFee.status === 200 || voidFee.status === 201, `status=${voidFee.status}`);
  await booksBalanced('final');

  await db.end();
  console.log(`\n${fail === 0 ? '✓ ALL PASS' : '✗ FAILURES'}: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error('ACCEPTANCE CRASHED:', e); process.exit(1); });
