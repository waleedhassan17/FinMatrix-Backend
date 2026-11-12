/**
 * FinMatrix — company backup (data portability), end to end.
 * ============================================================
 * An owner's backup ZIP is the whole company and nothing but the company, so
 * this drives the feature through the real API on real books, with TWO fresh
 * companies side by side:
 *
 *   A. Tenant isolation (launch blocker): company A's ZIP holds not one row of
 *      company B — checked per file by id set, and by B's distinctive names.
 *   B. Completeness: every data file's row count equals COUNT(*) for that
 *      entity and company, computed by the registry's own scope SQL.
 *   C. Integrity: the manifest's trial balance equals the Trial Balance report,
 *      and its debits equal its credits.
 *   D. Access: staff get 403 on every route; an expired link gets
 *      EXPORT_EXPIRED; a forged link gets EXPORT_LINK_INVALID; the fourth
 *      backup inside an hour gets EXPORT_RATE_LIMITED.
 *   E. The ZIP opens: CSVs carry a UTF-8 BOM, the workbook and the five PDFs
 *      are present, and Urdu text survives the round trip.
 *
 * Usage: boot the API (with EXPORT_WORKER_ENABLED, the default), then
 *   API_BASE=http://localhost:3000/api/v1 \
 *   DATABASE_URL=postgres://... \
 *   npm run test:data-export
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
const { Client } = require('pg');
const AdmZip = require('adm-zip');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const RUN = Date.now().toString().slice(-8);
const PASSWORD = 'Test1234!';

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
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 400) : ''}`,
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
  path: string,
  body?: unknown,
  token?: string,
): Promise<Res> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${path}`, {
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
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

async function signin(email: string, password: string) {
  const r = await req('POST', '/auth/signin', { email, password });
  if (r.status !== 200 && r.status !== 201)
    throw new Error(
      `signin ${email} failed: ${r.status} ${JSON.stringify(r.body)}`,
    );
  return r.data.tokens.accessToken as string;
}

/** A fresh, approved company with a verified owner — as qa/provision-flow-ctx. */
async function provisionCompany(pg: any, label: string) {
  const email = `export${label}${RUN}@finmatrix.pk`;
  const signup = await req('POST', '/auth/signup', {
    email,
    password: PASSWORD,
    displayName: `Export Owner ${label}`,
    phone: '+92-300-1234567',
    role: 'admin',
  });
  if (!signup.data?.tokens?.accessToken)
    throw new Error(
      `signup failed: ${signup.status} ${JSON.stringify(signup.body)}`,
    );
  const bootstrapToken = signup.data.tokens.accessToken;
  const userId = signup.data.user.id;
  // Every company route sits behind EmailVerifiedGuard, and the flag is read
  // off the user row per request — so verify in SQL first, no new token needed.
  await pg.query(
    `UPDATE users SET is_email_verified = true,
            email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`,
    [userId],
  );
  const co = await req(
    'POST',
    '/companies',
    { name: `Export Co ${label} ${RUN}`, industry: 'Retail' },
    bootstrapToken,
  );
  if (!co.data?.id)
    throw new Error(
      `company create failed: ${co.status} ${JSON.stringify(co.body)}`,
    );
  const companyId = co.data.id as string;
  await req('POST', `/companies/${companyId}/submit`, {}, bootstrapToken);
  await pg.query(
    `UPDATE companies SET status = 'active', subscription_plan = 'standard',
            subscription_status = 'active' WHERE id = $1`,
    [companyId],
  );
  const token = await signin(email, PASSWORD);
  return { email, userId, companyId, token };
}

async function accountId(token: string, number: string) {
  const r = await req('GET', '/accounts?limit=200', undefined, token);
  const list = Array.isArray(r.data)
    ? r.data
    : (r.data?.accounts ?? r.data?.items ?? r.data?.data ?? []);
  const acct = list.find((a: any) => a.accountNumber === number);
  if (!acct)
    throw new Error(
      `account ${number} not found: ${JSON.stringify(r.body).slice(0, 300)}`,
    );
  return acct.id as string;
}

/** Real activity: a customer, an open invoice, a part payment, a vendor and an open bill. */
async function seedActivity(c: { token: string }, tag: string) {
  const T = c.token;
  const today = new Date().toISOString().slice(0, 10);
  const customer = await req(
    'POST',
    '/customers',
    {
      name: `${tag} گاہک Customer ${RUN}`,
      email: `${tag.toLowerCase()}.cust.${RUN}@example.test`,
    },
    T,
  );
  if (!customer.data?.id)
    throw new Error(`customer: ${JSON.stringify(customer.body)}`);
  const vendor = await req(
    'POST',
    '/vendors',
    { companyName: `${tag} Vendor ${RUN}` },
    T,
  );
  if (!vendor.data?.id)
    throw new Error(`vendor: ${JSON.stringify(vendor.body)}`);
  const sales = await accountId(T, '4000');
  const rent = await accountId(T, '6000');
  const invoice = await req(
    'POST',
    '/invoices',
    {
      customerId: customer.data.id,
      invoiceDate: today,
      dueDate: '2099-12-31',
      status: 'sent',
      lines: [
        {
          description: `${tag} consulting`,
          quantity: '2',
          unitPrice: '1500',
          taxRate: '0',
          lineKind: 'service',
          accountId: sales,
        },
      ],
    },
    T,
  );
  if (!invoice.data?.id)
    throw new Error(`invoice: ${JSON.stringify(invoice.body)}`);
  const payment = await req(
    'POST',
    '/payments',
    {
      customerId: customer.data.id,
      paymentDate: today,
      amount: '1000',
      paymentMethod: 'cash',
      applications: [{ invoiceId: invoice.data.id, amount: '1000' }],
    },
    T,
  );
  if (!payment.data?.id)
    throw new Error(`payment: ${JSON.stringify(payment.body)}`);
  const bill = await req(
    'POST',
    '/bills',
    {
      vendorId: vendor.data.id,
      billDate: today,
      dueDate: '2099-12-31',
      lines: [{ description: `${tag} rent`, amount: '5000', accountId: rent }],
    },
    T,
  );
  if (!bill.data?.id) throw new Error(`bill: ${JSON.stringify(bill.body)}`);
  return {
    customer: customer.data,
    vendor: vendor.data,
    invoice: invoice.data,
    bill: bill.data,
  };
}

async function waitReady(token: string, id: string, timeoutMs = 180_000) {
  const started = Date.now();
  for (;;) {
    const r = await req(
      'GET',
      `/data-portability/exports/${id}`,
      undefined,
      token,
    );
    const status = r.data?.status;
    if (status === 'ready' || status === 'failed') return r.data;
    if (Date.now() - started > timeoutMs)
      throw new Error(
        `export ${id} not ready after ${timeoutMs} ms (status ${status})`,
      );
    await sleep(2_000);
  }
}

async function main() {
  if (!DB)
    throw new Error(
      'DATABASE_URL is required (companies are approved directly).',
    );
  console.log(`\n=== Company backup acceptance @ ${API} (run ${RUN}) ===\n`);
  const pg = new Client({ connectionString: DB });
  await pg.connect();

  // The registry's own scope SQL, so a new entity is counted the same way the
  // export reads it, without this test knowing the schema.
  const { AppDataSource } = require('../src/database/data-source');
  const {
    EXPORT_ENTITIES,
    countSql,
  } = require('../src/modules/data-portability/exporter/export-entities');
  await AppDataSource.initialize();

  try {
    console.log('── Provision two companies with real activity');
    const A = await provisionCompany(pg, 'A');
    const B = await provisionCompany(pg, 'B');
    const seedA = await seedActivity(A, 'Alpha');
    const seedB = await seedActivity(B, 'ZZZBRAVO');
    ok(
      'two companies provisioned and seeded',
      !!seedA.invoice.id && !!seedB.invoice.id,
    );

    console.log('\n── Request a backup for A (with workbook) and wait for it');
    const created = await req(
      'POST',
      '/data-portability/exports',
      { includeXlsx: true },
      A.token,
    );
    ok(
      'POST /data-portability/exports → 202 queued',
      created.status === 202 && created.data?.status === 'queued',
      created.body,
    );
    const exportId = created.data.id as string;
    const listed = await req(
      'GET',
      '/data-portability/exports',
      undefined,
      A.token,
    );
    ok(
      'GET list shows the new export first',
      Array.isArray(listed.data) && listed.data[0]?.id === exportId,
      listed.body,
    );
    const ready = await waitReady(A.token, exportId);
    ok('export reaches ready', ready.status === 'ready', ready);
    ok(
      'ready export has a size, an expiry and a download link',
      ready.sizeBytes > 0 &&
        !!ready.expiresAt &&
        typeof ready.downloadUrl === 'string',
      ready,
    );

    console.log('\n── Download without a session and open the ZIP');
    const dl = await fetch(ready.downloadUrl);
    ok(
      'download → 200 application/zip',
      dl.status === 200 &&
        (dl.headers.get('content-type') ?? '').includes('application/zip'),
      dl.status,
    );
    const zipBytes = Buffer.from(await dl.arrayBuffer());
    ok(
      'download length equals sizeBytes',
      zipBytes.length === Number(ready.sizeBytes),
      { got: zipBytes.length, want: ready.sizeBytes },
    );
    const zip = new AdmZip(zipBytes);
    const names: string[] = zip.getEntries().map((e: any) => e.entryName);
    const manifest = JSON.parse(zip.readAsText('manifest.json'));
    ok(
      'manifest.json present with format finmatrix-backup v1',
      manifest.format === 'finmatrix-backup' && manifest.formatVersion === 1,
      manifest.format,
    );
    ok(
      'manifest names company A',
      manifest.company?.id === A.companyId,
      manifest.company,
    );
    ok(
      'workbook present when includeXlsx',
      names.includes('FinMatrix-Export.xlsx'),
    );
    for (const pdf of [
      'trial-balance',
      'balance-sheet',
      'profit-and-loss',
      'ar-aging',
      'ap-aging',
    ]) {
      const entry = zip.getEntry(`reports/${pdf}.pdf`);
      ok(
        `reports/${pdf}.pdf present and is a PDF`,
        !!entry && entry.getData().subarray(0, 4).toString() === '%PDF',
      );
    }
    const csvNames = names.filter(
      (n) => n.startsWith('data/') && n.endsWith('.csv'),
    );
    ok(
      'one CSV per registry entry',
      csvNames.length === EXPORT_ENTITIES.length,
      { csv: csvNames.length, registry: EXPORT_ENTITIES.length },
    );

    console.log(
      '\n── B. Completeness: CSV rows = COUNT(*) per entity, and manifest counts agree',
    );
    const idSetsA: Record<string, Set<string>> = {};
    for (const def of EXPORT_ENTITIES) {
      const text: string = zip.readAsText(`data/${def.name}.csv`);
      const hasBom = text.charCodeAt(0) === 0xfeff;
      const lines = (hasBom ? text.slice(1) : text)
        .split('\n')
        .filter((l) => l.length > 0);
      const rows = Math.max(0, lines.length - 1);
      const { sql } = countSql(AppDataSource.manager, def);
      const [{ n }] = await pg
        .query(sql, [A.companyId])
        .then((r: any) => r.rows);
      const manifestRows = manifest.entities?.[def.name]?.rows;
      ok(
        `${def.name}: ${rows} rows = COUNT(*) ${n} = manifest ${manifestRows}`,
        rows === Number(n) && manifestRows === rows && hasBom,
        { rows, n, manifestRows, hasBom },
      );
      // The id column is first in every file; collect for the isolation check.
      idSetsA[def.name] = new Set(lines.slice(1).map((l) => l.split(',')[0]));
    }

    console.log("\n── A. Tenant isolation: nothing of B in A's ZIP");
    const bIds: string[] = [];
    for (const def of EXPORT_ENTITIES) {
      const meta = AppDataSource.getMetadata(def.entity);
      const { sql } = countSql(AppDataSource.manager, def);
      const idSql = sql.replace(
        'SELECT COUNT(*)::int AS n',
        `SELECT ${sql.includes(' c WHERE') ? 'c.id' : 'id'} AS id`,
      );
      const rows = await pg
        .query(idSql, [B.companyId])
        .then((r: any) => r.rows);
      for (const r of rows) {
        bIds.push(r.id);
        if (idSetsA[def.name]?.has(r.id))
          ok(`B row ${meta.tableName}/${r.id} leaked into A`, false);
      }
    }
    ok(
      `B has rows to leak (${bIds.length}) and none appear in A's files`,
      bIds.length > 0 && failures.every((f) => !f.includes('leaked')),
    );
    let leakedText = 0;
    for (const n of csvNames) {
      const t = zip.readAsText(n);
      if (t.includes('ZZZBRAVO') || t.includes(B.companyId)) leakedText++;
    }
    ok("B's names and company id never appear in A's CSVs", leakedText === 0, {
      leakedText,
    });
    ok(
      "A's own Urdu customer name survives the round trip",
      zip.readAsText('data/customers.csv').includes('گاہک'),
    );

    console.log(
      '\n── C. Manifest trial balance equals the Trial Balance report',
    );
    const tb = await req(
      'GET',
      `/reports/trial-balance?startDate=1970-01-01&endDate=${manifest.asOf}`,
      undefined,
      A.token,
    );
    const m = manifest.trialBalance;
    ok(
      'manifest debits = credits',
      m.totalDebits === m.totalCredits && Number(m.totalDebits) > 0,
      m,
    );
    ok(
      'manifest totals equal the report totals',
      Number(m.totalDebits) === Number(tb.data?.totalDebits) &&
        Number(m.totalCredits) === Number(tb.data?.totalCredits),
      {
        manifest: [m.totalDebits, m.totalCredits],
        report: [tb.data?.totalDebits, tb.data?.totalCredits],
      },
    );
    const reportRows: any[] = tb.data?.rows ?? [];
    const sameRows =
      reportRows.length === m.accounts.length &&
      reportRows.every((r) => {
        const a = m.accounts.find((x: any) => x.number === r.accountCode);
        return (
          a &&
          Number(a.debit) === Number(r.debit) &&
          Number(a.credit) === Number(r.credit)
        );
      });
    ok(
      `manifest accounts (${m.accounts.length}) equal the report rows (${reportRows.length}) one for one`,
      sameRows,
    );

    console.log('\n── D. Access control and link lifecycle');
    const staff = await req(
      'POST',
      '/settings/users',
      {
        name: 'Export Staff',
        username: `expstaff${RUN}`,
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
    const staffToken = await signin(`expstaff${RUN}`, PASSWORD);
    const s1 = await req('POST', '/data-portability/exports', {}, staffToken);
    const s2 = await req(
      'GET',
      '/data-portability/exports',
      undefined,
      staffToken,
    );
    const s3 = await req(
      'GET',
      `/data-portability/exports/${exportId}`,
      undefined,
      staffToken,
    );
    ok(
      'staff cannot create, list or read exports (403)',
      s1.status === 403 && s2.status === 403 && s3.status === 403,
      [s1.status, s2.status, s3.status],
    );
    const crossRead = await req(
      'GET',
      `/data-portability/exports/${exportId}`,
      undefined,
      B.token,
    );
    ok(
      "B's owner cannot read A's export (404)",
      crossRead.status === 404,
      crossRead.status,
    );

    const forged = await fetch(
      ready.downloadUrl.replace(/token=.*$/, 'token=abc.def'),
    );
    const forgedBody = await forged.json().catch(() => null);
    ok(
      'a forged link → 403 EXPORT_LINK_INVALID',
      forged.status === 403 &&
        (forgedBody?.error?.code ?? forgedBody?.code) === 'EXPORT_LINK_INVALID',
      [forged.status, forgedBody],
    );

    // Expire it the way time would: push expires_at into the past, re-list to
    // see the link gone, and mint-by-row is impossible, so use the old link.
    await pg.query(
      `UPDATE company_exports SET expires_at = now() - interval '1 hour' WHERE id = $1`,
      [exportId],
    );
    const afterExpiry = await req(
      'GET',
      `/data-portability/exports/${exportId}`,
      undefined,
      A.token,
    );
    ok(
      'an expired export no longer advertises a download link',
      afterExpiry.data?.downloadUrl === null,
      afterExpiry.data,
    );
    const expiredDl = await fetch(ready.downloadUrl);
    const expiredBody = await expiredDl.json().catch(() => null);
    ok(
      'the old link → 410 EXPORT_EXPIRED',
      expiredDl.status === 410 &&
        (expiredBody?.error?.code ?? expiredBody?.code) === 'EXPORT_EXPIRED',
      [expiredDl.status, expiredBody],
    );

    console.log('\n── Rate limit: three an hour per company');
    const r2 = await req('POST', '/data-portability/exports', {}, A.token);
    const r3 = await req('POST', '/data-portability/exports', {}, A.token);
    const r4 = await req('POST', '/data-portability/exports', {}, A.token);
    ok(
      '2nd and 3rd backups accepted, 4th refused with EXPORT_RATE_LIMITED',
      r2.status === 202 &&
        r3.status === 202 &&
        r4.status === 429 &&
        codeOf(r4) === 'EXPORT_RATE_LIMITED',
      [r2.status, r3.status, r4.status, codeOf(r4)],
    );
    const bOwn = await req('POST', '/data-portability/exports', {}, B.token);
    ok(
      "B's limit is its own (B's first backup accepted)",
      bOwn.status === 202,
      bOwn.status,
    );
    const bReady = await waitReady(B.token, bOwn.data.id);
    const bZip = new AdmZip(
      Buffer.from(await (await fetch(bReady.downloadUrl)).arrayBuffer()),
    );
    ok(
      "B's backup holds no Alpha rows",
      !bZip.readAsText('data/customers.csv').includes('Alpha') &&
        !bZip.readAsText('data/invoices.csv').includes(A.companyId),
    );
  } finally {
    await pg.end();
    await AppDataSource.destroy().catch(() => undefined);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) {
    console.log('Failures:\n  - ' + failures.join('\n  - '));
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\nFATAL:', err);
  process.exit(1);
});
