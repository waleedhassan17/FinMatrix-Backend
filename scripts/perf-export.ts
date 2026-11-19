/**
 * Company backup — performance run (NOT part of CI).
 * ===================================================
 * Fills a throwaway company with N documents straight in SQL (the point is
 * export throughput, not posting), asks the API for a backup, and reports how
 * long the worker took and the peak memory it recorded.
 *
 * Needs a booted API and DATABASE_URL. The company is created through the API
 * as the acceptance scripts do, so the export runs under a real owner session.
 *
 *   API_BASE=http://localhost:3000/api/v1 DATABASE_URL=postgres://... \
 *   DOCS=50000 npm run perf:export
 */
export {};

/* eslint-disable @typescript-eslint/no-var-requires */
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const DOCS = Number(process.env.DOCS || 50_000);
const RUN = Date.now().toString().slice(-8);
const PASSWORD = 'Test1234!';

async function req(method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json: any = await r.json().catch(() => null);
  return { status: r.status, data: json?.data ?? json, body: json };
}

async function main() {
  if (!DB) throw new Error('DATABASE_URL is required');
  const pg = new Client({ connectionString: DB });
  await pg.connect();
  try {
    const email = `perf${RUN}@finmatrix.pk`;
    const signup = await req('POST', '/auth/signup', { email, password: PASSWORD, displayName: 'Perf Owner', phone: '+92-300-1234567', role: 'admin' });
    const t0 = signup.data.tokens.accessToken;
    await pg.query(`UPDATE users SET is_email_verified = true, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`, [signup.data.user.id]);
    const co = await req('POST', '/companies', { name: `Perf Co ${RUN}`, industry: 'Retail' }, t0);
    const companyId = co.data.id as string;
    await req('POST', `/companies/${companyId}/submit`, {}, t0);
    await pg.query(`UPDATE companies SET status='active', subscription_plan='standard', subscription_status='active' WHERE id=$1`, [companyId]);
    const signin = await req('POST', '/auth/signin', { email, password: PASSWORD });
    const token = signin.data.tokens.accessToken as string;
    const userId = signup.data.user.id as string;

    console.log(`Seeding ${DOCS} invoices (+2 lines each) and ${DOCS * 2} ledger rows into ${companyId} …`);
    const seedStart = Date.now();
    await pg.query(`INSERT INTO customers (company_id, name, code) SELECT $1, 'Perf Customer ' || g, 'C-' || lpad(g::text, 5, '0') FROM generate_series(1, 200) g`, [companyId]);
    const { rows: custRows } = await pg.query(`SELECT id FROM customers WHERE company_id = $1`, [companyId]);
    const custIds: string[] = custRows.map((r: any) => r.id);
    const { rows: acctRows } = await pg.query(`SELECT id, account_number FROM accounts WHERE company_id = $1 AND account_number IN ('1100','4000')`, [companyId]);
    const ar = acctRows.find((a: any) => a.account_number === '1100')?.id;
    const sales = acctRows.find((a: any) => a.account_number === '4000')?.id;
    await pg.query(
      `INSERT INTO invoices (company_id, customer_id, invoice_number, invoice_date, due_date, subtotal, total, amount_paid, balance, status, payment_terms, created_by, version)
       SELECT $1, ($2::uuid[])[1 + (g % $3)], 'PERF-' || g, CURRENT_DATE - (g % 365), CURRENT_DATE + 30, 1000, 1000, CASE WHEN g % 2 = 0 THEN 1000 ELSE 0 END, CASE WHEN g % 2 = 0 THEN 0 ELSE 1000 END, CASE WHEN g % 2 = 0 THEN 'paid' ELSE 'sent' END, 'net30', $4, 1
       FROM generate_series(1, $5) g`,
      [companyId, custIds, custIds.length, userId, DOCS],
    );
    await pg.query(
      `INSERT INTO invoice_line_items (invoice_id, description, quantity, unit_price, tax_rate, tax_amount, line_total, account_id, line_order)
       SELECT i.id, 'Perf line ' || l, 1, 500, 0, 0, 500, $2::uuid, l FROM invoices i CROSS JOIN generate_series(0, 1) l WHERE i.company_id = $1::uuid`,
      [companyId, sales],
    );
    await pg.query(
      `INSERT INTO general_ledger (company_id, date, reference, account_id, debit, credit, balance, source_type, source_id, memo)
       SELECT $1::uuid, i.invoice_date, 'JE-' || row_number() OVER (), $2::uuid, 1000, 0, 0, 'invoice', i.id, NULL FROM invoices i WHERE i.company_id = $1::uuid
       UNION ALL
       SELECT $1::uuid, i.invoice_date, 'JE-' || row_number() OVER (), $3::uuid, 0, 1000, 0, 'invoice', i.id, NULL FROM invoices i WHERE i.company_id = $1::uuid`,
      [companyId, ar, sales],
    );
    console.log(`Seeded in ${((Date.now() - seedStart) / 1000).toFixed(1)} s`);

    const started = Date.now();
    const created = await req('POST', '/data-portability/exports', { includeXlsx: process.env.XLSX === 'true' }, token);
    if (created.status !== 202) throw new Error(`export request failed: ${created.status} ${JSON.stringify(created.body)}`);
    let view: any;
    for (;;) {
      view = (await req('GET', `/data-portability/exports/${created.data.id}`, undefined, token)).data;
      if (view.status === 'ready' || view.status === 'failed') break;
      await new Promise((r) => setTimeout(r, 3000));
    }
    const wall = Date.now() - started;
    console.log('\n=== Result ===');
    console.log(JSON.stringify({
      status: view.status,
      error: view.error,
      sizeMb: view.sizeBytes ? (view.sizeBytes / 1_048_576).toFixed(1) : null,
      wallClockMs: wall,
      workerDurationMs: view.summary?.durationMs,
      peakRssMb: view.summary?.peakRssMb,
      rows: view.summary?.entities,
    }, null, 2));
  } finally {
    await pg.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
