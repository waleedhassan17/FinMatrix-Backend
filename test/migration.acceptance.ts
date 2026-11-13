/**
 * FinMatrix — Migration Center, end to end through the API.
 * ===========================================================
 * Two fresh companies: A (empty books, inventory tier) is migrated; B has
 * ordinary activity and must come out of the whole run untouched.
 *
 *   1. Gates: books not empty → MIGRATION_REQUIRES_EMPTY_BOOKS; staff → 403;
 *      another company's batch → 404; the starter workbook downloads.
 *   2. Faulty golden files cannot import, each failing the right check:
 *      (b) unbalanced TB, (c) AR detail ≠ control, (d) stock ≠ inventory.
 *   3. (e) duplicates + ambiguous dates raise the right issues, and resolving
 *      them (dd/mm, merge, skip) makes the batch ready with all ten checks.
 *   4. (f) a messy generic spreadsheet is read, mapped and questioned.
 *   5. (a) the clean starter workbook: validate → dry run → sign-off → commit;
 *      every check Rs 0; TB balances; A = L + E; Migration Clearing = 0.
 *   6. Rollback returns A to its exact pre-migration state (TB and counts).
 *   7. Migrate again; receive a payment on a migrated invoice and pay a
 *      migrated bill through the normal flows; a posting before the cutover
 *      is refused by the period lock; a migrated invoice cannot be voided;
 *      rollback is now ROLLBACK_BLOCKED; close ends rollback for good.
 *   8. Company B: trial balance and row counts unchanged.
 *
 * Usage: boot the API, then
 *   API_BASE=http://localhost:3000/api/v1 DATABASE_URL=postgres://... npm run test:migration
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const RUN = Date.now().toString().slice(-8);
const PASSWORD = 'Test1234!';
const FIX = path.join(__dirname, 'fixtures', 'migration');
const CUTOVER = '2026-06-30';
/** The hard checks: SOURCE_READBACK first, then the nine of §1.7. */
const CHECKS = 10;
const TODAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Karachi',
}).format(new Date());

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
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : ''}`,
    );
  }
};

interface Res {
  status: number;
  body: any;
  data: any;
}
async function req(
  method: string,
  p: string,
  body?: unknown,
  token?: string,
): Promise<Res> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${p}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed, data: parsed?.data ?? parsed };
}
const codeOf = (r: Res) => r.body?.error?.code ?? r.body?.code ?? null;

async function upload(
  token: string,
  batchId: string,
  file: string,
): Promise<Res> {
  const form = new FormData();
  form.append('files', new Blob([fs.readFileSync(path.join(FIX, file))]), file);
  const r = await fetch(`${API}/migrations/${batchId}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const json: any = await r.json().catch(() => null);
  return { status: r.status, body: json, data: json?.data ?? json };
}

async function signin(email: string, password: string) {
  const r = await req('POST', '/auth/signin', { email, password });
  if (r.status !== 200 && r.status !== 201)
    throw new Error(
      `signin ${email} failed: ${r.status} ${JSON.stringify(r.body)}`,
    );
  return r.data.tokens.accessToken as string;
}

async function provision(pg: any, label: string) {
  const email = `migr${label}${RUN}@finmatrix.pk`;
  const signup = await req('POST', '/auth/signup', {
    email,
    password: PASSWORD,
    displayName: `Migration Owner ${label}`,
    phone: '+92-300-1234567',
    role: 'admin',
  });
  if (!signup.data?.tokens?.accessToken)
    throw new Error(
      `signup failed: ${signup.status} ${JSON.stringify(signup.body)}`,
    );
  const userId = signup.data.user.id;
  await pg.query(
    `UPDATE users SET is_email_verified = true, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`,
    [userId],
  );
  const co = await req(
    'POST',
    '/companies',
    { name: `Migration Co ${label} ${RUN}`, industry: 'Retail' },
    signup.data.tokens.accessToken,
  );
  if (!co.data?.id)
    throw new Error(
      `company create failed: ${co.status} ${JSON.stringify(co.body)}`,
    );
  const companyId = co.data.id as string;
  await req(
    'POST',
    `/companies/${companyId}/submit`,
    {},
    signup.data.tokens.accessToken,
  );
  await pg.query(
    `UPDATE companies SET status = 'active', subscription_plan = 'standard', subscription_status = 'active',
            company_type = 'warehouse', inventory_enabled = true WHERE id = $1`,
    [companyId],
  );
  return { email, userId, companyId, token: await signin(email, PASSWORD) };
}

async function accountByNumber(token: string, number: string) {
  const r = await req('GET', '/accounts?limit=200', undefined, token);
  const list = Array.isArray(r.data)
    ? r.data
    : (r.data?.accounts ?? r.data?.items ?? []);
  return list.find((a: any) => a.accountNumber === number);
}

const COUNT_TABLES = [
  'customers',
  'vendors',
  'inventory_items',
  'invoices',
  'bills',
  'inventory_movements',
  'payments',
  'bill_payments',
];
async function snapshot(pg: any, token: string, companyId: string) {
  const tb = await req(
    'GET',
    `/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31`,
    undefined,
    token,
  );
  const counts: Record<string, number> = {};
  for (const t of COUNT_TABLES)
    counts[t] = Number(
      (
        await pg.query(
          `SELECT COUNT(*)::int AS n FROM ${t} WHERE company_id = $1`,
          [companyId],
        )
      ).rows[0].n,
    );
  counts.active_accounts = Number(
    (
      await pg.query(
        `SELECT COUNT(*)::int AS n FROM accounts WHERE company_id = $1 AND is_active`,
        [companyId],
      )
    ).rows[0].n,
  );
  const balances = (
    await pg.query(
      `SELECT account_number, balance::text FROM accounts WHERE company_id = $1 ORDER BY account_number`,
      [companyId],
    )
  ).rows;
  return {
    tbRows: JSON.stringify(tb.data?.rows ?? []),
    totals: [tb.data?.totalDebits, tb.data?.totalCredits],
    counts,
    balances: JSON.stringify(balances),
  };
}

async function newBatch(token: string, source = 'finmatrix_template') {
  const r = await req(
    'POST',
    '/migrations',
    { sourceSystem: source, cutoverDate: CUTOVER },
    token,
  );
  if (r.status !== 201 && r.status !== 200)
    throw new Error(
      `create batch failed: ${r.status} ${JSON.stringify(r.body)}`,
    );
  return r.data;
}

async function issues(token: string, id: string) {
  return (
    await req('GET', `/migrations/${id}/issues?limit=200`, undefined, token)
  ).data;
}

async function main() {
  if (!DB) throw new Error('DATABASE_URL is required.');
  console.log(`\n=== Migration Center acceptance @ ${API} (run ${RUN}) ===\n`);
  const pg = new Client({ connectionString: DB });
  await pg.connect();
  try {
    console.log('── Provision company A (empty books) and B (with activity)');
    const A = await provision(pg, 'A');
    const B = await provision(pg, 'B');
    const sales = await accountByNumber(B.token, '4000');
    const bCust = await req(
      'POST',
      '/customers',
      { name: `ZZB Customer ${RUN}` },
      B.token,
    );
    const bInv = await req(
      'POST',
      '/invoices',
      {
        customerId: bCust.data.id,
        invoiceDate: TODAY,
        dueDate: '2099-12-31',
        status: 'sent',
        lines: [
          {
            description: 'B sale',
            quantity: '1',
            unitPrice: '7777',
            taxRate: '0',
            accountId: sales.id,
            lineKind: 'service',
          },
        ],
      },
      B.token,
    );
    ok(
      'company B has real activity (a posted invoice)',
      !!bInv.data?.id,
      bInv.body,
    );
    const B0 = await snapshot(pg, B.token, B.companyId);
    const A0 = await snapshot(pg, A.token, A.companyId);

    console.log('\n── 1. Gates');
    const bTry = await req(
      'POST',
      '/migrations',
      { sourceSystem: 'finmatrix_template', cutoverDate: CUTOVER },
      B.token,
    );
    ok(
      'books with postings → 409 MIGRATION_REQUIRES_EMPTY_BOOKS',
      bTry.status === 409 && codeOf(bTry) === 'MIGRATION_REQUIRES_EMPTY_BOOKS',
      bTry.body,
    );
    const future = await req(
      'POST',
      '/migrations',
      { sourceSystem: 'finmatrix_template', cutoverDate: '2999-01-01' },
      A.token,
    );
    ok('a future cutover date is refused', future.status === 400, future.body);
    const staff = await req(
      'POST',
      '/settings/users',
      {
        name: 'Migration Staff',
        username: `migstaff${RUN}`,
        password: PASSWORD,
        role: 'staff',
      },
      A.token,
    );
    ok(
      'staff user created',
      staff.status === 201 || staff.status === 200,
      staff.body,
    );
    const staffToken = await signin(`migstaff${RUN}`, PASSWORD);
    const s1 = await req('GET', '/migrations', undefined, staffToken);
    const s2 = await req(
      'POST',
      '/migrations',
      { sourceSystem: 'finmatrix_template', cutoverDate: CUTOVER },
      staffToken,
    );
    const s3 = await req('GET', '/migrations/template', undefined, staffToken);
    ok(
      'staff are refused every migration route (403)',
      s1.status === 403 && s2.status === 403 && s3.status === 403,
      [s1.status, s2.status, s3.status],
    );
    const tpl = await fetch(
      `${API}/migrations/template?cutoverDate=${CUTOVER}`,
      { headers: { Authorization: `Bearer ${A.token}` } },
    );
    const tplBytes = Buffer.from(await tpl.arrayBuffer());
    ok(
      'starter workbook downloads as an XLSX',
      tpl.status === 200 && tplBytes.readUInt32BE(0) === 0x504b0304,
      tpl.status,
    );

    console.log('\n── 2. Faulty golden files cannot be imported');
    for (const [file, expectFail] of [
      ['b-unbalanced-tb.xlsx', ['SOURCE_TB_BALANCED']],
      ['c-ar-mismatch.xlsx', ['AR_MATCHES', 'CLEARING_ZERO']],
      ['d-stock-mismatch.xlsx', ['INVENTORY_MATCHES', 'CLEARING_ZERO']],
    ] as const) {
      const b = await newBatch(A.token);
      const up = await upload(A.token, b.id, file);
      ok(
        `${file}: uploaded and analysed (status mapped)`,
        up.status === 200 && up.data?.status === 'mapped',
        up.body,
      );
      const v = await req('POST', `/migrations/${b.id}/validate`, {}, A.token);
      const failedCodes = (v.data?.checks ?? [])
        .filter((c: any) => !c.passed)
        .map((c: any) => c.code);
      ok(
        `${file}: validated, not ready (${failedCodes.join(', ')})`,
        v.data?.status === 'validated' &&
          expectFail.every((c) => failedCodes.includes(c)),
        v.data,
      );
      const failing = (v.data?.checks ?? []).find(
        (c: any) => c.code === expectFail[0],
      );
      ok(
        `${file}: the failing check explains itself (expected, actual, difference, details)`,
        !!failing &&
          failing.label &&
          failing.details?.length > 0 &&
          failing.difference !== '0.00',
        failing,
      );
      const so = await req(
        'POST',
        `/migrations/${b.id}/sign-off`,
        { confirmed: true, spotCheckDone: true },
        A.token,
      );
      const cm = await req('POST', `/migrations/${b.id}/commit`, {}, A.token);
      ok(
        `${file}: sign-off and commit are refused`,
        so.status === 409 &&
          cm.status === 409 &&
          codeOf(cm) === 'MIGRATION_INVALID_TRANSITION',
        [so.status, codeOf(so), cm.status, codeOf(cm)],
      );
    }

    console.log('\n── 3. (e) duplicates and ambiguous dates');
    {
      const b = await newBatch(A.token);
      await upload(A.token, b.id, 'e-duplicates-ambiguous-dates.xlsx');
      let iss = await issues(A.token, b.id);
      const codes = iss.items.map((i: any) => i.code);
      ok(
        'ambiguous dates are asked about, never guessed',
        codes.filter((c: string) => c === 'AMBIGUOUS_DATE_FORMAT').length === 2,
        iss.groups,
      );
      ok(
        'the duplicate customer is flagged',
        codes.includes('DUPLICATE_RECORD'),
        iss.groups,
      );
      const v0 = await req('POST', `/migrations/${b.id}/validate`, {}, A.token);
      ok(
        'not importable while issues are open',
        v0.data?.status === 'validated' && v0.data?.readiness < 100,
        [v0.data?.status, v0.data?.readiness],
      );
      for (const i of iss.items.filter(
        (x: any) => x.code === 'AMBIGUOUS_DATE_FORMAT',
      )) {
        const r = await req(
          'PATCH',
          `/migrations/${b.id}/issues/${i.id}`,
          { action: 'map', value: 'dmy' },
          A.token,
        );
        ok(`dates in ${i.field} read as dd/mm/yyyy`, r.status === 200, r.body);
      }
      iss = await issues(A.token, b.id);
      const dupCustomer = iss.items.find(
        (x: any) =>
          x.code === 'DUPLICATE_RECORD' && String(x.field).startsWith('dup::'),
      );
      const merge = await req(
        'PATCH',
        `/migrations/${b.id}/issues/${dupCustomer.id}`,
        { action: 'map', value: 'merge' },
        A.token,
      );
      ok(
        'duplicate customer merged into the first row',
        merge.status === 200,
        merge.body,
      );
      iss = await issues(A.token, b.id);
      const dupInvoice = iss.items.find(
        (x: any) =>
          x.code === 'DUPLICATE_RECORD' && x.field === 'invoiceNumber',
      );
      ok(
        'the repeated invoice row is flagged once its dates are known',
        !!dupInvoice,
        iss.items.map((x: any) => [x.code, x.field]),
      );
      const noReason = await req(
        'PATCH',
        `/migrations/${b.id}/issues/${dupInvoice.id}`,
        { action: 'skip' },
        A.token,
      );
      ok('skipping needs a reason', noReason.status === 400, noReason.body);
      const skip = await req(
        'PATCH',
        `/migrations/${b.id}/issues/${dupInvoice.id}`,
        { action: 'skip', reason: 'Typed twice in the old sheet' },
        A.token,
      );
      ok(
        'repeated invoice row skipped with its reason',
        skip.status === 200,
        skip.body,
      );
      const v = await req('POST', `/migrations/${b.id}/validate`, {}, A.token);
      ok(
        '(e) resolved: ready, readiness 100, all ten checks pass',
        v.data?.status === 'ready' &&
          v.data?.readiness === 100 &&
          (v.data?.checks ?? []).length === CHECKS &&
          v.data.checks.every((c: any) => c.passed),
        v.data,
      );
      const dry = await req('POST', `/migrations/${b.id}/dry-run`, {}, A.token);
      const skipped = dry.data?.certificate?.rejectedRows?.find(
        (r: any) => r.reason === 'Typed twice in the old sheet',
      );
      ok(
        'the certificate lists the skipped row with its reason',
        !!skipped,
        dry.data?.certificate?.rejectedRows,
      );
    }

    console.log('\n── 4. (f) a messy generic spreadsheet');
    {
      const b = await newBatch(A.token, 'generic_spreadsheet');
      const up = await upload(A.token, b.id, 'f-messy-generic.xlsx');
      ok(
        '(f) uploaded and analysed',
        up.status === 200 && up.data?.status === 'mapped',
        up.body,
      );
      const m = (
        await req('GET', `/migrations/${b.id}/mappings`, undefined, A.token)
      ).data;
      const sheet = (name: string) =>
        m.sheets.find((s: any) => s.sheet === name);
      ok(
        'trial balance found from "A/c Code / Ledger / Dr / Cr" under a title row',
        sheet('TB June 2026')?.target === 'trial_balance' &&
          sheet('TB June 2026')?.confidence >= 0.9,
        sheet('TB June 2026'),
      );
      ok(
        'customers found from Roman Urdu headers ("Gahak List", "Naam", "Shehar")',
        sheet('Gahak List')?.target === 'customers',
        sheet('Gahak List'),
      );
      ok(
        'stock found ("Closing Stock")',
        sheet('Closing Stock')?.target === 'stock',
        sheet('Closing Stock'),
      );
      ok(
        'the notes sheet is ignored',
        sheet('Notes')?.target === null,
        sheet('Notes'),
      );
      const iss = await issues(A.token, b.id);
      ok(
        'look-alike sheets are confirmed by the owner, not guessed',
        iss.items.some(
          (i: any) =>
            i.code === 'MAPPING_UNCONFIRMED' && i.sheet === 'Party Balances',
        ),
        iss.groups,
      );
      ok(
        'accounts with no type are asked about (UNKNOWN_ACCOUNT)',
        iss.items.filter((i: any) => i.code === 'UNKNOWN_ACCOUNT').length === 2,
        iss.groups,
      );
      const tbRows = (
        await pg.query(
          `SELECT outcome, reason FROM migration_staging_rows WHERE batch_id = $1 AND entity_type = 'trial_balance'`,
          [b.id],
        )
      ).rows;
      ok(
        'the TOTAL line is accounted for as a rejected row with a reason',
        tbRows.some(
          (r: any) => r.outcome === 'rejected' && /total/i.test(r.reason),
        ),
        tbRows,
      );
    }

    console.log('\n── 5. (a) the clean starter workbook');
    const a = await newBatch(A.token);
    const upA = await upload(A.token, a.id, 'a-clean-starter.xlsx');
    ok(
      '(a) uploaded: no blocking issues',
      upA.status === 200 && upA.data?.issues?.blocking === 0,
      upA.data?.issues,
    );
    const cross = await req('GET', `/migrations/${a.id}`, undefined, B.token);
    ok(
      "another company's owner cannot see this batch (404)",
      cross.status === 404,
      cross.status,
    );
    const vA = await req('POST', `/migrations/${a.id}/validate`, {}, A.token);
    ok(
      '(a) ready at 100% readiness',
      vA.data?.status === 'ready' && vA.data?.readiness === 100,
      [vA.data?.status, vA.data?.readiness],
    );
    for (const c of vA.data?.checks ?? [])
      ok(
        `  ${c.code}: expected ${c.expected}, actual ${c.actual}, difference ${c.difference}`,
        c.passed && (c.difference === '0.00' || c.difference === '0'),
        c,
      );
    const dryA = await req('POST', `/migrations/${a.id}/dry-run`, {}, A.token);
    ok(
      'dry run returns the certificate preview with spot checks that match',
      dryA.data?.certificate?.allPassed === true &&
        dryA.data.certificate.spotChecks.length >= 5 &&
        dryA.data.certificate.spotChecks.every((s: any) => s.matches),
      dryA.data?.certificate?.spotChecks,
    );
    const afterDry = await snapshot(pg, A.token, A.companyId);
    ok(
      'the dry run left nothing behind (books still empty)',
      afterDry.tbRows === A0.tbRows &&
        JSON.stringify(afterDry.counts) === JSON.stringify(A0.counts),
      { before: A0.counts, after: afterDry.counts },
    );
    const prevCert = await fetch(`${API}/migrations/${a.id}/certificate`, {
      headers: { Authorization: `Bearer ${A.token}` },
    });
    ok(
      'certificate preview downloads as a PDF',
      prevCert.status === 200 &&
        prevCert.headers.get('x-certificate-preview') === 'true' &&
        Buffer.from(await prevCert.arrayBuffer())
          .subarray(0, 4)
          .toString() === '%PDF',
      prevCert.status,
    );
    const early = await req('POST', `/migrations/${a.id}/commit`, {}, A.token);
    ok(
      'commit before sign-off → 409 NOT_SIGNED_OFF',
      early.status === 409 && codeOf(early) === 'NOT_SIGNED_OFF',
      early.body,
    );
    const half = await req(
      'POST',
      `/migrations/${a.id}/sign-off`,
      { confirmed: true, spotCheckDone: false },
      A.token,
    );
    ok(
      'sign-off without the spot checks → NOT_SIGNED_OFF',
      half.status === 400 && codeOf(half) === 'NOT_SIGNED_OFF',
      half.body,
    );
    const so = await req(
      'POST',
      `/migrations/${a.id}/sign-off`,
      { confirmed: true, spotCheckDone: true },
      A.token,
    );
    ok('signed off', so.status === 200 && !!so.data?.signedOffAt, so.body);
    const cm = await req('POST', `/migrations/${a.id}/commit`, {}, A.token);
    ok(
      '(a) committed',
      cm.status === 200 && cm.data?.batch?.status === 'committed',
      cm.body,
    );
    await assertBooks(pg, A, '(a) after commit');
    const finalCert = await fetch(`${API}/migrations/${a.id}/certificate`, {
      headers: { Authorization: `Bearer ${A.token}` },
    });
    ok(
      'final certificate downloads (not a preview)',
      finalCert.status === 200 &&
        finalCert.headers.get('x-certificate-preview') === 'false',
      finalCert.status,
    );

    console.log('\n── 6. Rollback restores the exact pre-migration state');
    const rb = await req('POST', `/migrations/${a.id}/rollback`, {}, A.token);
    ok(
      'rolled back',
      rb.status === 200 && rb.data?.batch?.status === 'rolled_back',
      rb.body,
    );
    const A1 = await snapshot(pg, A.token, A.companyId);
    ok(
      'trial balance identical to before the migration',
      A1.tbRows === A0.tbRows &&
        JSON.stringify(A1.totals) === JSON.stringify(A0.totals),
      { before: A0.tbRows, after: A1.tbRows },
    );
    ok(
      'row counts identical (customers, vendors, items, documents, movements, active accounts)',
      JSON.stringify(A1.counts) === JSON.stringify(A0.counts),
      { before: A0.counts, after: A1.counts },
    );
    const lockAfterRb = (
      await pg.query(`SELECT books_locked_until FROM companies WHERE id = $1`, [
        A.companyId,
      ])
    ).rows[0].books_locked_until;
    ok('period lock restored', lockAfterRb === null, lockAfterRb);

    console.log('\n── 7. Migrate again, then use the migrated books');
    const a2 = await newBatch(A.token);
    await upload(A.token, a2.id, 'a-clean-starter.xlsx');
    const v2 = await req('POST', `/migrations/${a2.id}/validate`, {}, A.token);
    ok(
      'second migration ready (books count as empty after a rollback)',
      v2.data?.status === 'ready',
      v2.data?.status,
    );
    await req(
      'POST',
      `/migrations/${a2.id}/sign-off`,
      { confirmed: true, spotCheckDone: true },
      A.token,
    );
    const cm2 = await req('POST', `/migrations/${a2.id}/commit`, {}, A.token);
    ok(
      'second migration committed',
      cm2.data?.batch?.status === 'committed',
      cm2.body,
    );
    const again = await req(
      'POST',
      '/migrations',
      { sourceSystem: 'finmatrix_template', cutoverDate: CUTOVER },
      A.token,
    );
    ok(
      'a third migration is refused while one is in place',
      again.status === 409 &&
        codeOf(again) === 'MIGRATION_REQUIRES_EMPTY_BOOKS',
      again.body,
    );

    const inv = (
      await pg.query(
        `SELECT id, customer_id, balance::text, status, journal_entry_id FROM invoices WHERE company_id = $1 AND legacy_ref = 'INV-1001'`,
        [A.companyId],
      )
    ).rows[0];
    ok(
      'migrated invoice INV-1001 is open with 120,000 due and points at its entry',
      inv &&
        Number(inv.balance) === 120000 &&
        inv.status === 'sent' &&
        !!inv.journal_entry_id,
      inv,
    );
    const pay = await req(
      'POST',
      '/payments',
      {
        customerId: inv.customer_id,
        paymentDate: TODAY,
        amount: '50000',
        paymentMethod: 'cash',
        applications: [{ invoiceId: inv.id, amount: '50000' }],
      },
      A.token,
    );
    ok(
      'Receive payment against the migrated invoice',
      pay.status === 201 || pay.status === 200,
      pay.body,
    );
    const invAfter = (
      await pg.query(
        `SELECT balance::text, status FROM invoices WHERE id = $1`,
        [inv.id],
      )
    ).rows[0];
    const custAfter = (
      await pg.query(`SELECT balance::text FROM customers WHERE id = $1`, [
        inv.customer_id,
      ])
    ).rows[0];
    // Its due date (15 May) has passed, so the normal payment flow marks it overdue rather than partial.
    ok(
      'invoice part-paid with 70,000 due (overdue: due 15 May); customer owes 115,000',
      Number(invAfter.balance) === 70000 &&
        ['partial', 'overdue'].includes(invAfter.status) &&
        Number(custAfter.balance) === 115000,
      { invAfter, custAfter },
    );
    const partInv = (
      await pg.query(
        `SELECT status, amount_paid::text AS paid FROM invoices WHERE company_id = $1 AND legacy_ref = 'INV-1002'`,
        [A.companyId],
      )
    ).rows[0];
    ok(
      'a part-paid source invoice arrives partial with its paid amount (INV-1002: 35,000 paid)',
      partInv.status === 'partial' && Number(partInv.paid) === 35000,
      partInv,
    );

    const bill = (
      await pg.query(
        `SELECT id, vendor_id, balance::text FROM bills WHERE company_id = $1 AND legacy_ref = 'KP-7781'`,
        [A.companyId],
      )
    ).rows[0];
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      'base64',
    );
    const form = new FormData();
    form.append('proof', new Blob([png], { type: 'image/png' }), 'receipt.png');
    const proofRes = await fetch(`${API}/bill-payments/proofs`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${A.token}` },
      body: form,
    });
    const proof: any = await proofRes.json().catch(() => null);
    const bank = await accountByNumber(A.token, '1010');
    const pb = await req(
      'POST',
      '/bills/pay',
      {
        vendorId: bill.vendor_id,
        paymentDate: TODAY,
        paymentMethod: 'bank_transfer',
        bankAccountId: bank.id,
        proofId: proof?.data?.id ?? proof?.id,
        applications: [{ billId: bill.id, amount: '100000' }],
      },
      A.token,
    );
    ok(
      'Pay Bills settles the migrated bill KP-7781',
      pb.status === 201 || pb.status === 200,
      pb.body,
    );
    const billAfter = (
      await pg.query(`SELECT balance::text, status FROM bills WHERE id = $1`, [
        bill.id,
      ])
    ).rows[0];
    ok(
      'bill paid in full',
      Number(billAfter.balance) === 0 && billAfter.status === 'paid',
      billAfter,
    );
    await assertBooks(pg, A, 'after payment and bill payment', {
      skipFixtureTotals: true,
    });

    const cash = await accountByNumber(A.token, '1000');
    const equity = await accountByNumber(A.token, '3000');
    const backdated = await req(
      'POST',
      '/journal-entries',
      {
        date: '2026-06-15',
        memo: 'Back-dated',
        status: 'posted',
        lines: [
          { accountId: cash.id, debit: '10', credit: '0' },
          { accountId: equity.id, debit: '0', credit: '10' },
        ],
      },
      A.token,
    );
    ok(
      'a posting dated before the cutover is refused (PERIOD_LOCKED)',
      codeOf(backdated) === 'PERIOD_LOCKED',
      backdated.body,
    );
    const otherInv = (
      await pg.query(
        `SELECT id FROM invoices WHERE company_id = $1 AND legacy_ref = 'INV-1003'`,
        [A.companyId],
      )
    ).rows[0];
    const voidTry = await req(
      'POST',
      `/invoices/${otherInv.id}/void`,
      { reason: 'test' },
      A.token,
    );
    ok(
      'a migrated invoice cannot be voided (MIGRATED_DOCUMENT_IMMUTABLE)',
      voidTry.status === 409 &&
        codeOf(voidTry) === 'MIGRATED_DOCUMENT_IMMUTABLE',
      voidTry.body,
    );

    const blocked = await req(
      'POST',
      `/migrations/${a2.id}/rollback`,
      {},
      A.token,
    );
    ok(
      'rollback after a payment → 409 ROLLBACK_BLOCKED, listing what depends on it',
      blocked.status === 409 &&
        codeOf(blocked) === 'ROLLBACK_BLOCKED' &&
        (blocked.body?.error?.details?.blockers ?? []).length > 0,
      blocked.body,
    );
    const close = await req('POST', `/migrations/${a2.id}/close`, {}, A.token);
    ok(
      'migration closed',
      close.status === 200 && close.data?.status === 'closed',
      close.body,
    );
    const rbClosed = await req(
      'POST',
      `/migrations/${a2.id}/rollback`,
      {},
      A.token,
    );
    ok(
      'a closed migration cannot be undone (MIGRATION_INVALID_TRANSITION)',
      rbClosed.status === 409 &&
        codeOf(rbClosed) === 'MIGRATION_INVALID_TRANSITION',
      rbClosed.body,
    );

    console.log('\n── 9. TallyPrime: the same books from five XML exports');
    {
      const C = await provision(pg, 'C');
      const t = await newBatch(C.token, 'tally');
      const form = new FormData();
      for (const f of [
        'tally-masters.xml',
        'tally-trial-balance.xml',
        'tally-bills-receivable.xml',
        'tally-bills-payable.xml',
        'tally-stock-summary.xml',
      ]) {
        form.append(
          'files',
          new Blob([fs.readFileSync(path.join(FIX, 'tally', f))], {
            type: 'application/xml',
          }),
          f,
        );
      }
      const upT = await fetch(`${API}/migrations/${t.id}/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${C.token}` },
        body: form,
      });
      const upTBody: any = await upT.json().catch(() => null);
      ok(
        'five Tally XML files upload in one request and are analysed',
        upT.status === 200 &&
          upTBody?.data?.status === 'mapped' &&
          upTBody.data.files.length === 5,
        upTBody,
      );
      const m = (
        await req('GET', `/migrations/${t.id}/mappings`, undefined, C.token)
      ).data;
      ok(
        'all eight starter sheets are produced from Tally at full confidence',
        m.sheets.length === 8 &&
          m.sheets.every((s: any) => s.target && s.confidence === 1),
        m.sheets.map((s: any) => [s.sheet, s.target, s.confidence]),
      );
      ok(
        'no issues: groups, parties, reserved ledgers and subtotals are all understood',
        upTBody?.data?.issues?.blocking === 0 &&
          upTBody?.data?.issues?.warning === 0,
        upTBody?.data?.issues,
      );
      const vt = await req('POST', `/migrations/${t.id}/validate`, {}, C.token);
      ok(
        'Tally: ready at 100%, all ten checks pass at zero difference',
        vt.data?.status === 'ready' &&
          vt.data?.readiness === 100 &&
          (vt.data?.checks ?? []).every((c: any) => c.passed),
        vt.data?.checks?.map((c: any) => [c.code, c.passed, c.difference]),
      );
      await req(
        'POST',
        `/migrations/${t.id}/sign-off`,
        { confirmed: true, spotCheckDone: true },
        C.token,
      );
      const ct = await req('POST', `/migrations/${t.id}/commit`, {}, C.token);
      ok(
        'Tally migration committed',
        ct.data?.batch?.status === 'committed',
        ct.body,
      );
      await assertBooks(pg, C, 'Tally after commit');
      const parties = (
        await pg.query(
          `SELECT name FROM customers WHERE company_id = $1 ORDER BY name`,
          [C.companyId],
        )
      ).rows.map((r: any) => r.name);
      ok(
        'Sundry Debtors became customers, Urdu name intact',
        JSON.stringify(parties) ===
          JSON.stringify([
            'Al-Noor Traders',
            'Bismillah Store',
            'Raza & Sons',
            'گلشن کریانہ',
          ]),
        parties,
      );
      const newAccts = (
        await pg.query(
          `SELECT account_number, name, type, sub_type FROM accounts WHERE company_id = $1 AND account_number ~ '^[0-9]{5}$' ORDER BY account_number`,
          [C.companyId],
        )
      ).rows;
      ok(
        'ledgers became typed accounts (bank, fixed asset, loan, capital)',
        JSON.stringify(
          newAccts.map((a: any) => [a.account_number, a.type, a.sub_type]),
        ) ===
          JSON.stringify([
            ['18001', 'asset', 'Fixed Asset'],
            ['18002', 'asset', 'Bank'],
            ['28001', 'liability', 'Notes Payable'],
            ['38001', 'equity', 'Owner Equity'],
          ]),
        newAccts,
      );
    }

    console.log('\n── 8. Company B untouched');
    const B1 = await snapshot(pg, B.token, B.companyId);
    ok("B's trial balance unchanged", B1.tbRows === B0.tbRows, {
      before: B0.tbRows,
      after: B1.tbRows,
    });
    ok(
      "B's row counts and account balances unchanged",
      JSON.stringify(B1.counts) === JSON.stringify(B0.counts) &&
        B1.balances === B0.balances,
      { before: B0.counts, after: B1.counts },
    );
    const leaked = (
      await pg.query(
        `SELECT COUNT(*)::int AS n FROM migration_staging_rows s JOIN migration_batches b ON b.id = s.batch_id WHERE s.company_id <> b.company_id`,
      )
    ).rows[0].n;
    ok(
      'no staging row belongs to a different company than its batch',
      Number(leaked) === 0,
      leaked,
    );

    // ── 10 ────────────────────────────────────────────────────────────────
    console.log('\n── 10. Readback: every figure read two ways (fixture g)');
    {
      const G = await provision(pg, 'g');
      const b = await newBatch(G.token);
      const up = await upload(G.token, b.id, 'g-amount-forms.xlsx');
      ok(
        '(g) uploaded and analysed',
        up.status === 200 && up.data?.status === 'mapped',
        up.body,
      );
      const iss = await issues(G.token, b.id);
      const rb = (iss.items ?? []).filter(
        (i: any) => i.code === 'AMOUNT_READBACK_MISMATCH',
      );
      const blocking = (iss.items ?? []).filter(
        (i: any) => i.severity === 'blocking',
      );
      ok(
        '(g): the one cell the two readers disagree on ("12,0000") is raised, and nothing else',
        rb.length === 1 &&
          rb[0].field === 'amountDue' &&
          rb[0].severity === 'blocking' &&
          blocking.length === 1,
        iss.groups,
      );
      const v0 = await req('POST', `/migrations/${b.id}/validate`, {}, G.token);
      ok(
        '(g): not ready while the owner has not decided that cell',
        v0.data?.status !== 'ready' && v0.data?.readiness < 100,
        [v0.data?.status, v0.data?.readiness],
      );
      const fix = await req(
        'PATCH',
        `/migrations/${b.id}/issues/${rb[0].id}`,
        { action: 'edit', value: '120000' },
        G.token,
      );
      ok(
        '(g): the owner types the amount plainly',
        fix.status === 200,
        fix.body,
      );
      const v = await req('POST', `/migrations/${b.id}/validate`, {}, G.token);
      const checks = v.data?.checks ?? [];
      ok(
        '(g): ready at 100% with all ten checks passing, SOURCE_READBACK first',
        v.data?.status === 'ready' &&
          v.data?.readiness === 100 &&
          checks.length === CHECKS &&
          checks[0]?.code === 'SOURCE_READBACK' &&
          checks.every((c: any) => c.passed),
        checks.map((c: any) => [c.code, c.passed, c.expected, c.actual]),
      );
      const dry = await req('POST', `/migrations/${b.id}/dry-run`, {}, G.token);
      const cert = dry.data?.certificate;
      const at = cert?.asTyped;
      const cash = at?.trialBalance?.find((r: any) => r.account === '1000');
      const inv = at?.openItems?.find((r: any) => r.document === 'INV-1001');
      const stock = at?.stock?.find((r: any) => r.sku === 'CHR-001');
      ok(
        '(g): the certificate carries every figure as typed, as read and as posted',
        cash?.debitText === '۱۵۰۰۰۰' &&
          cash?.readAs === 'Dr 150000' &&
          Number(String(cash?.posted).replace(/^Dr /, '')) === 150000 &&
          inv?.asTyped === '120000' &&
          inv?.readAs === '120000' &&
          stock?.costText === 'Rs 8,500' &&
          stock?.quantityText === '12' &&
          Number(String(stock?.onHand).split('×')[0]) === 12,
        { cash, inv, stock },
      );
      ok(
        '(g): every spot check lists its documents as typed',
        (cert?.spotChecks ?? []).length > 0 &&
          cert.spotChecks.every(
            (s: any) =>
              Array.isArray(s.asTyped) && s.asTyped.length === s.documents,
          ),
        cert?.spotChecks,
      );

      // A bug in the first reader, simulated: two parsed figures changed,
      // the text as typed untouched, the trial balance still balanced.
      const mutate = async (acct: string, col: string, value: string) =>
        pg.query(
          `UPDATE migration_staging_rows SET normalized = jsonb_set(normalized, $3, to_jsonb($4::text))
            WHERE batch_id = $1 AND entity_type = 'trial_balance' AND normalized->>'accountNumber' = $2`,
          [b.id, acct, `{${col}}`, value],
        );
      await mutate('1000', 'debit', '140000');
      await mutate('3100', 'credit', '219250.5');
      const vm = await req('POST', `/migrations/${b.id}/validate`, {}, G.token);
      const cm = vm.data?.checks ?? [];
      const rbm = cm.find((c: any) => c.code === 'SOURCE_READBACK');
      ok(
        'mutation: the nine older checks all pass on the misread figures (both their sides read the same parse)',
        cm.length === CHECKS &&
          cm
            .filter((c: any) => c.code !== 'SOURCE_READBACK')
            .every((c: any) => c.passed),
        cm.map((c: any) => [c.code, c.passed, c.difference]),
      );
      ok(
        'mutation: SOURCE_READBACK alone catches it, naming both cells, and the batch is not ready',
        !!rbm &&
          rbm.passed === false &&
          rbm.details.length === 2 &&
          rbm.details.every((d: any) =>
            ['1,50,000', '۱۵۰۰۰۰', '2,29,250.50'].includes(d.asTyped),
          ) &&
          vm.data?.status === 'validated' &&
          vm.data?.readiness < 100,
        rbm,
      );
      const so = await req(
        'POST',
        `/migrations/${b.id}/sign-off`,
        { confirmed: true, spotCheckDone: true },
        G.token,
      );
      ok('mutation: sign-off is refused', so.status === 409, so.body);
      await mutate('1000', 'debit', '150000');
      await mutate('3100', 'credit', '229250.5');
      const vr = await req('POST', `/migrations/${b.id}/validate`, {}, G.token);
      ok(
        'restored: ready again once the figures read the same two ways',
        vr.data?.status === 'ready' && vr.data?.readiness === 100,
        [vr.data?.status, vr.data?.readiness],
      );
    }

    // ── 11 ────────────────────────────────────────────────────────────────
    console.log('\n── 11. Concurrency: a retried commit cannot post twice');
    {
      const H = await provision(pg, 'h');
      const b = await newBatch(H.token);
      await upload(H.token, b.id, 'a-clean-starter.xlsx');
      const v = await req('POST', `/migrations/${b.id}/validate`, {}, H.token);
      ok('(h) ready', v.data?.status === 'ready', [
        v.data?.status,
        v.data?.readiness,
      ]);
      const so = await req(
        'POST',
        `/migrations/${b.id}/sign-off`,
        { confirmed: true, spotCheckDone: true },
        H.token,
      );
      ok('(h) signed off', so.status === 200, so.body);
      const commit = () =>
        req('POST', `/migrations/${b.id}/commit`, {}, H.token);
      const [c1, c2] = await Promise.all([commit(), commit()]);
      const statuses = [c1.status, c2.status].sort();
      ok(
        'one of two simultaneous commits posts; the other is refused as already imported',
        statuses[0] === 200 &&
          statuses[1] === 409 &&
          [c1, c2].some((c) => codeOf(c) === 'MIGRATION_INVALID_TRANSITION'),
        [c1.status, codeOf(c1), c2.status, codeOf(c2)],
      );
      const tb = await req(
        'GET',
        '/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31',
        undefined,
        H.token,
      );
      ok(
        'the books were posted exactly once',
        tb.data?.isBalanced === true &&
          Number(tb.data?.totalDebits) === 1092500.5,
        [tb.data?.totalDebits, tb.data?.totalCredits],
      );
      const lateDry = await req(
        'POST',
        `/migrations/${b.id}/dry-run`,
        {},
        H.token,
      );
      const after = await req('GET', `/migrations/${b.id}`, undefined, H.token);
      ok(
        'a dry-run arriving after the commit is refused and leaves the batch committed',
        lateDry.status === 409 &&
          after.data?.status === 'committed' &&
          !!after.data?.signedOffAt,
        [lateDry.status, codeOf(lateDry), after.data?.status],
      );
      const undo = () =>
        req('POST', `/migrations/${b.id}/rollback`, {}, H.token);
      const [r1, r2] = await Promise.all([undo(), undo()]);
      const rs = [r1.status, r2.status].sort();
      const tb2 = await req(
        'GET',
        '/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31',
        undefined,
        H.token,
      );
      ok(
        'one of two simultaneous undos reverses; the other is refused; the books are back to zero',
        rs[0] === 200 &&
          rs[1] === 409 &&
          Number(tb2.data?.totalDebits) === 0 &&
          Number(tb2.data?.totalCredits) === 0,
        [r1.status, codeOf(r1), r2.status, codeOf(r2), tb2.data?.totalDebits],
      );
    }
  } finally {
    await pg.end();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

/** TB balances, A = L + E, Migration Clearing = 0, and the fixture's own totals. */
async function assertBooks(
  pg: any,
  A: { token: string; companyId: string },
  label: string,
  opts: { skipFixtureTotals?: boolean } = {},
) {
  const tb = await req(
    'GET',
    `/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31`,
    undefined,
    A.token,
  );
  ok(
    `${label}: trial balance balances`,
    tb.data?.isBalanced === true &&
      tb.data.totalDebits === tb.data.totalCredits,
    [tb.data?.totalDebits, tb.data?.totalCredits],
  );
  if (!opts.skipFixtureTotals)
    ok(
      `${label}: debits = credits = 1,092,500.50`,
      Number(tb.data?.totalDebits) === 1092500.5,
      tb.data?.totalDebits,
    );
  const bs = await req(
    'GET',
    `/reports/balance-sheet?asOfDate=${TODAY}`,
    undefined,
    A.token,
  );
  ok(
    `${label}: Assets = Liabilities + Equity`,
    bs.data?.isBalanced === true &&
      Math.abs(
        Number(bs.data.totalAssets) - Number(bs.data.totalLiabilitiesAndEquity),
      ) < 0.001,
    [bs.data?.totalAssets, bs.data?.totalLiabilitiesAndEquity],
  );
  const clr = (
    await pg.query(
      `SELECT balance::text FROM accounts WHERE company_id = $1 AND account_number = '3950'`,
      [A.companyId],
    )
  ).rows[0];
  ok(`${label}: Migration Clearing = 0`, Number(clr.balance) === 0, clr);
  if (opts.skipFixtureTotals) return;
  const ar = await req('GET', '/reports/ar-aging', undefined, A.token);
  const ap = await req('GET', '/reports/ap-aging', undefined, A.token);
  ok(
    `${label}: AR aging totals 245,000 and AP aging 163,250`,
    Number(ar.data?.totals?.total) === 245000 &&
      Number(ap.data?.totals?.total) === 163250,
    [ar.data?.totals?.total, ap.data?.totals?.total],
  );
  const items = (
    await pg.query(
      `SELECT sku, quantity_on_hand::text AS q, unit_cost::text AS c FROM inventory_items WHERE company_id = $1 ORDER BY sku`,
      [A.companyId],
    )
  ).rows;
  ok(
    `${label}: stock on hand and cost as in the file`,
    JSON.stringify(items.map((i: any) => [i.sku, Number(i.q), Number(i.c)])) ===
      JSON.stringify([
        ['CHR-001', 12, 8500],
        ['CUS-001', 24, 1250],
        ['TBL-001', 2, 25000],
      ]),
    items,
  );
  const lock = (
    await pg.query(
      `SELECT books_locked_until::text AS l FROM companies WHERE id = $1`,
      [A.companyId],
    )
  ).rows[0].l;
  ok(
    `${label}: books locked through the day before the cutover`,
    lock === '2026-06-29',
    lock,
  );
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
