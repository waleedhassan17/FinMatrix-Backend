/**
 * Scale test for the Migration Center on a production-sized set of books,
 * measured on the real server process.
 *
 *   1. Build the workbook (default 5,000 customers, 1,000 vendors, 3,000 items
 *      with stock, 15,000 open invoices, 3,000 open bills; override with
 *      CUSTOMERS / VENDORS / ITEMS / INVOICES / BILLS):
 *        PERF_BUILD=/tmp/books.xlsx npm run perf:migration
 *
 *   2. Start the compiled API the way the 1 GB Fargate task runs it, e.g.
 *        node --max-old-space-size=768 dist/main.js
 *      and measure it:
 *        PERF_XLSX=/tmp/books.xlsx API_PID=<pid> DATABASE_URL=... \
 *          API_BASE=http://localhost:3000/api/v1 npm run perf:migration
 *
 * Step 2 signs up a fresh owner, then times every step the owner triggers —
 * upload + analysis, validate (practice import, ten checks), sign-off,
 * commit, undo — over HTTP. Around each step it resets and reads the API
 * process's peak resident memory (VmHWM in /proc/<pid>/status), so the
 * figures are the server's own, not a test harness's. It also counts the
 * audit-trail rows the commit wrote. Not part of CI.
 */
import * as fs from 'fs';
import {
  BooksSpec,
  buildStarterXlsx,
  fromCents,
  mul,
  sum,
  toCents,
} from '../test/fixtures/migration/workbook-builder';

const n = (k: string, d: number) => Number(process.env[k] ?? d);
const SIZES = {
  customers: n('CUSTOMERS', 5000),
  vendors: n('VENDORS', 1000),
  items: n('ITEMS', 3000),
  invoices: n('INVOICES', 15000),
  bills: n('BILLS', 3000),
};
const API = process.env.API_BASE ?? 'http://localhost:3000/api/v1';
const PASSWORD = 'Perf1234!';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function bigBooks(): BooksSpec {
  const r = rng(42);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const lakh = (v: string) => {
    const [w, f] = v.split('.');
    const body =
      w.length > 3
        ? w.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') +
          ',' +
          w.slice(-3)
        : w;
    return f ? `${body}.${f}` : body;
  };
  const money = () =>
    `${int(1, 2000) * 50}.${String(int(0, 99)).padStart(2, '0')}`;
  const date = () =>
    `${String(int(1, 28)).padStart(2, '0')}/${String(int(1, 6)).padStart(2, '0')}/2026`;

  const customers = Array.from({ length: SIZES.customers }, (_, i) => ({
    code: `C-${String(i + 1).padStart(5, '0')}`,
    name: `Customer ${i + 1}`,
    city: ['Lahore', 'Karachi', 'Faisalabad', 'Multan'][i % 4],
  }));
  const vendors = Array.from({ length: SIZES.vendors }, (_, i) => ({
    code: `V-${String(i + 1).padStart(5, '0')}`,
    name: `Vendor ${i + 1}`,
  }));
  const items = Array.from({ length: SIZES.items }, (_, i) => ({
    sku: `SKU-${String(i + 1).padStart(5, '0')}`,
    name: `Item ${i + 1}`,
    unit: 'pcs',
    cost: String(int(1, 400) * 25),
    price: String(int(401, 800) * 25),
  }));
  const dues: string[] = [];
  const openInvoices = Array.from({ length: SIZES.invoices }, (_, i) => {
    const due = money();
    dues.push(due);
    return {
      customer: customers[i % customers.length].code!,
      number: `INV-${i + 1}`,
      date: date(),
      original: lakh(due),
      amountDue: lakh(due),
    };
  });
  const billDues: string[] = [];
  const openBills = Array.from({ length: SIZES.bills }, (_, i) => {
    const due = money();
    billDues.push(due);
    return {
      vendor: vendors[i % vendors.length].code!,
      number: `B-${i + 1}`,
      date: date(),
      original: lakh(due),
      amountDue: lakh(due),
    };
  });
  const stock = items.map((it) => ({
    sku: it.sku,
    qty: String(int(1, 200)),
    cost: it.cost,
  }));
  const ar = sum(dues);
  const ap = sum(billDues);
  const inv = sum(stock.map((s) => mul(s.qty, s.cost)));
  const cash = '2500000';
  const loan = '1000000';
  const equity = sum([cash, ar, inv, `-${ap}`, `-${loan}`]);
  if (toCents(equity) <= 0n)
    throw new Error('generated equity is not positive');
  return {
    cutoverDate: '2026-06-30',
    accounts: [
      {
        number: '2100',
        name: 'Loan',
        type: 'Liability',
        kind: 'Notes Payable',
      },
    ],
    customers,
    vendors,
    items,
    trialBalance: [
      { number: '1000', name: 'Cash', debit: lakh(cash) },
      { number: '1100', name: 'Accounts Receivable', debit: lakh(ar) },
      { number: '1200', name: 'Inventory', debit: lakh(inv) },
      { number: '2000', name: 'Accounts Payable', credit: lakh(ap) },
      { number: '2100', name: 'Loan', credit: lakh(loan) },
      {
        number: '3000',
        name: 'Owner Equity',
        credit: lakh(fromCents(toCents(equity))),
      },
    ],
    openInvoices,
    openBills,
    stock,
  };
}

// ── The server process's memory ───────────────────────────────────────────
const PID = process.env.API_PID;
const status = (key: 'VmHWM' | 'VmRSS'): number => {
  if (!PID) return NaN;
  const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(
    fs.readFileSync(`/proc/${PID}/status`, 'utf8'),
  );
  return m ? Number(m[1]) * 1024 : NaN;
};
/** Reset the peak-RSS watermark (Linux: "5" > clear_refs). */
const resetPeak = () => {
  if (PID) fs.writeFileSync(`/proc/${PID}/clear_refs`, '5');
};
const mb = (b: number) =>
  Number.isFinite(b) ? `${Math.round(b / 1024 / 1024)} MB` : 'n/a';

// ── HTTP ──────────────────────────────────────────────────────────────────
async function call(
  method: string,
  path: string,
  token?: string,
  body?: unknown,
): Promise<{ status: number; data: any; body: any }> {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body instanceof FormData
        ? {}
        : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body:
      body === undefined
        ? undefined
        : body instanceof FormData
          ? body
          : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: r.status, data: json?.data ?? json, body: json };
}

const must = <R extends { status: number; body: any }>(
  r: R,
  what: string,
): R => {
  if (r.status >= 300)
    throw new Error(
      `${what}: ${r.status} ${JSON.stringify(r.body).slice(0, 400)}`,
    );
  return r;
};

async function provision(
  pg: any,
): Promise<{ token: string; companyId: string }> {
  const run = Date.now().toString(36);
  const email = `perf${run}@finmatrix.pk`;
  const signup = must(
    await call('POST', '/auth/signup', undefined, {
      email,
      password: PASSWORD,
      displayName: 'Perf Owner',
      phone: '+92-300-1234567',
      role: 'admin',
    }),
    'signup',
  );
  await pg.query(
    `UPDATE users SET is_email_verified = true, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`,
    [signup.data.user.id],
  );
  const boot = signup.data.tokens.accessToken;
  const co = must(
    await call('POST', '/companies', boot, {
      name: `Perf Co ${run}`,
      industry: 'Retail',
    }),
    'company',
  );
  await call('POST', `/companies/${co.data.id}/submit`, boot, {});
  await pg.query(
    `UPDATE companies SET status = 'active', subscription_plan = 'standard', subscription_status = 'active',
            company_type = 'warehouse', inventory_enabled = true WHERE id = $1`,
    [co.data.id],
  );
  const signin = must(
    await call('POST', '/auth/signin', undefined, {
      email,
      password: PASSWORD,
    }),
    'signin',
  );
  return { token: signin.data.tokens.accessToken, companyId: co.data.id };
}

async function step<T>(name: string, fn: () => Promise<T>): Promise<T> {
  resetPeak();
  const t = Date.now();
  const out = await fn();
  const secs = ((Date.now() - t) / 1000).toFixed(1);
  console.log(
    `  ${name.padEnd(40)} ${secs.padStart(7)} s   server peak RSS ${mb(status('VmHWM'))}`,
  );
  return out;
}

async function main() {
  if (process.env.PERF_BUILD) {
    const buf = await buildStarterXlsx(bigBooks());
    fs.writeFileSync(process.env.PERF_BUILD, buf);
    console.log(
      `wrote ${process.env.PERF_BUILD} (${(buf.length / 1024 / 1024).toFixed(1)} MB) for ${JSON.stringify(SIZES)}`,
    );
    return;
  }
  const file = process.env.PERF_XLSX;
  if (!file || !process.env.DATABASE_URL)
    throw new Error('Set PERF_XLSX and DATABASE_URL (and API_PID for memory).');
  const { Client } = require('pg');
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  await pg.connect();
  try {
    console.log(`\nMigration scale test over HTTP: ${JSON.stringify(SIZES)}`);
    console.log(
      `  server idle RSS                          ${mb(status('VmRSS'))}`,
    );
    const { token, companyId } = await provision(pg);
    const batch = must(
      await call('POST', '/migrations', token, {
        sourceSystem: 'finmatrix_template',
        cutoverDate: '2026-06-30',
      }),
      'create',
    ).data;
    const id = batch.id;

    const buf = fs.readFileSync(file);
    const up = await step(
      `upload ${(buf.length / 1024 / 1024).toFixed(1)} MB + analyse`,
      async () => {
        const form = new FormData();
        form.append('files', new Blob([buf]), 'big-books.xlsx');
        return must(
          await call('POST', `/migrations/${id}/files`, token, form),
          'upload',
        );
      },
    );
    if (up.data.issues?.blocking > 0)
      throw new Error(
        `blocking issues after analysis: ${JSON.stringify(up.data.issues)}`,
      );
    const v = await step('validate (practice import, ten checks)', async () =>
      must(
        await call('POST', `/migrations/${id}/validate`, token, {}),
        'validate',
      ),
    );
    if (v.data.status !== 'ready')
      throw new Error(
        `not ready: ${v.data.status} ${(v.data.checks ?? []).filter((c: any) => !c.passed).map((c: any) => c.code)}`,
      );
    await step('sign-off', async () =>
      must(
        await call('POST', `/migrations/${id}/sign-off`, token, {
          confirmed: true,
          spotCheckDone: true,
        }),
        'sign-off',
      ),
    );
    await step('commit (real import, ten checks)', async () =>
      must(await call('POST', `/migrations/${id}/commit`, token, {}), 'commit'),
    );
    const tb = must(
      await call(
        'GET',
        '/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31',
        token,
      ),
      'tb',
    ).data;
    // The audit trail is written after the commit, off the request path.
    await new Promise((r) => setTimeout(r, 3000));
    const [audit] = (
      await pg.query(
        `SELECT COUNT(*)::int AS n FROM audit_trail WHERE company_id = $1`,
        [companyId],
      )
    ).rows;
    console.log(
      `  after commit: TB ${tb.totalDebits} = ${tb.totalCredits} (${tb.isBalanced ? 'balanced' : 'NOT BALANCED'}); audit_trail rows ${audit.n}`,
    );
    await step('undo', async () =>
      must(await call('POST', `/migrations/${id}/rollback`, token, {}), 'undo'),
    );
    const tb2 = must(
      await call(
        'GET',
        '/reports/trial-balance?startDate=1970-01-01&endDate=2999-12-31',
        token,
      ),
      'tb',
    ).data;
    console.log(`  after undo:   TB ${tb2.totalDebits} = ${tb2.totalCredits}`);
    console.log(
      `  server RSS at the end                    ${mb(status('VmRSS'))}`,
    );
  } finally {
    await pg.end();
  }
}

main().catch((e) => {
  console.error('\nFATAL:', e);
  process.exit(1);
});
