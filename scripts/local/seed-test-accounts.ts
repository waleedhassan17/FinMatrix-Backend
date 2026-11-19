/**
 * Test accounts for the local Migration Center test kit: one owner and one
 * empty warehouse company per sample folder in ~/FinMatrix-Migration-Samples,
 * plus a staff login that must NOT reach the Migration Center.
 *
 *   npm run local:seed      (scripts/local/reset.sh runs it after a reset)
 *
 * Refuses to run unless both the API and the database are on this machine:
 * it creates users and edits companies directly, which must never happen to
 * a shared or production database. Safe to run twice: existing accounts are
 * left as they are.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3100/api/v1';
const DB =
  process.env.DATABASE_URL ||
  'postgres://finmatrix_local:local-only-db-password@localhost:5434/finmatrix_local';
export const PASSWORD = 'Local#Test2026';

export interface TestAccount {
  email: string;
  company: string;
  /** The sample folder this account is for. */
  folder: string;
  /** Month the company's fiscal year starts (1–12). */
  fiscalYearStartMonth: number;
  note?: string;
}

/** Samples are an invented company with a July fiscal year, cutover 2026-10-01. */
export const TEST_ACCOUNTS: TestAccount[] = [
  { email: 'starter@finmatrix.local', company: 'Starter Workbook Test Co', folder: '01-starter', fiscalYearStartMonth: 7 },
  { email: 'peachtree.backup@finmatrix.local', company: 'Peachtree Backup Test Co', folder: '02-peachtree-backup', fiscalYearStartMonth: 7 },
  { email: 'peachtree.reports@finmatrix.local', company: 'Peachtree Reports Test Co', folder: '03-peachtree-reports-only', fiscalYearStartMonth: 7 },
  { email: 'tally@finmatrix.local', company: 'Tally Test Co', folder: '04-tally', fiscalYearStartMonth: 7 },
  { email: 'quickbooks.online@finmatrix.local', company: 'QuickBooks Online Test Co', folder: '05-quickbooks-online', fiscalYearStartMonth: 7 },
  { email: 'quickbooks.desktop@finmatrix.local', company: 'QuickBooks Desktop Test Co', folder: '06-quickbooks-desktop', fiscalYearStartMonth: 7 },
  { email: 'xero@finmatrix.local', company: 'Xero Test Co', folder: '07-xero', fiscalYearStartMonth: 7 },
  { email: 'zoho@finmatrix.local', company: 'Zoho Books Test Co', folder: '08-zoho-books', fiscalYearStartMonth: 7 },
  { email: 'odoo.enterprise@finmatrix.local', company: 'Odoo Enterprise Test Co', folder: '09-odoo-enterprise', fiscalYearStartMonth: 7 },
  { email: 'odoo.community@finmatrix.local', company: 'Odoo Community Test Co', folder: '10-odoo-community', fiscalYearStartMonth: 7 },
  { email: 'sage50@finmatrix.local', company: 'Sage 50 UK Test Co', folder: '11-sage-50-uk', fiscalYearStartMonth: 7 },
  { email: 'sage.accounting@finmatrix.local', company: 'Sage Accounting Test Co', folder: '12-sage-accounting', fiscalYearStartMonth: 7 },
  { email: 'busy@finmatrix.local', company: 'Busy Test Co', folder: '13-busy', fiscalYearStartMonth: 7 },
  { email: 'marg@finmatrix.local', company: 'Marg Test Co', folder: '14-marg', fiscalYearStartMonth: 7 },
  { email: 'generic@finmatrix.local', company: 'Generic Excel Test Co', folder: '15-generic-excel', fiscalYearStartMonth: 7 },
  { email: 'large@finmatrix.local', company: 'Large Files Test Co', folder: '90-large', fiscalYearStartMonth: 7 },
  { email: 'negative@finmatrix.local', company: 'Broken Files Test Co', folder: '99-negative', fiscalYearStartMonth: 7 },
  {
    email: 'peachtree.real@finmatrix.local',
    company: 'Your Peachtree Backup Co',
    folder: '(your own Peachtree backup)',
    fiscalYearStartMonth: 6,
    note: 'June fiscal year, as in your Peachtree company. Cutover 2026-10-06.',
  },
];
export const STAFF = { username: 'staff.tester', company: 'Starter Workbook Test Co' };

function assertLocal() {
  const api = new URL(API);
  const db = new URL(DB);
  const local = (h: string) => ['localhost', '127.0.0.1', '::1'].includes(h);
  if (!local(api.hostname) || !local(db.hostname)) {
    throw new Error(
      `Refusing to seed: API ${api.hostname} and database ${db.hostname} must both be on this machine.`,
    );
  }
}

async function call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; body: any; data: any }> {
  for (let attempt = 0; ; attempt++) {
    const res = await callOnce(method, path, body, token);
    if (res.status !== 429 || attempt >= 3) return res;
    // Sign-in is rate limited per address; wait for the window to pass.
    await new Promise((r) => setTimeout(r, 61_000));
  }
}

async function callOnce(method: string, path: string, body?: unknown, token?: string) {
  const r = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: r.status, body: json, data: json?.data ?? json };
}

async function ensureOwner(pg: any, a: TestAccount): Promise<{ token: string; created: boolean }> {
  const signin = await call('POST', '/auth/signin', { email: a.email, password: PASSWORD });
  if (signin.data?.tokens?.accessToken) return { token: signin.data.tokens.accessToken, created: false };
  const signup = await call('POST', '/auth/signup', {
    email: a.email,
    password: PASSWORD,
    displayName: `${a.company} Owner`,
    phone: '+92-300-0000000',
    role: 'admin',
  });
  if (!signup.data?.tokens?.accessToken)
    throw new Error(`signup ${a.email}: ${signup.status} ${JSON.stringify(signup.body).slice(0, 300)}`);
  await pg.query(
    `UPDATE users SET is_email_verified = true, email_verified_at = now() WHERE id = $1`,
    [signup.data.user.id],
  );
  const first = signup.data.tokens.accessToken;
  const co = await call('POST', '/companies', { name: a.company, industry: 'Wholesale & Distribution' }, first);
  if (!co.data?.id) throw new Error(`company ${a.company}: ${co.status} ${JSON.stringify(co.body).slice(0, 300)}`);
  await call('POST', `/companies/${co.data.id}/submit`, {}, first);
  await pg.query(
    `UPDATE companies SET status = 'active', subscription_plan = 'standard', subscription_status = 'active',
            company_type = 'warehouse', inventory_enabled = true, setup_completed = true,
            fiscal_year_start_month = $2 WHERE id = $1`,
    [co.data.id, a.fiscalYearStartMonth],
  );
  const again = await call('POST', '/auth/signin', { email: a.email, password: PASSWORD });
  return { token: again.data.tokens.accessToken, created: true };
}

async function main() {
  assertLocal();
  const pg = new Client({ connectionString: DB });
  await pg.connect();
  try {
    const rows: string[] = [];
    let starterToken = '';
    for (const a of TEST_ACCOUNTS) {
      const { token, created } = await ensureOwner(pg, a);
      if (a.folder === '01-starter') starterToken = token;
      rows.push(`${created ? 'created' : 'exists '}  ${a.email.padEnd(38)} ${a.folder}`);
    }
    const staff = await call(
      'POST',
      '/settings/users',
      { name: 'Staff Tester', username: STAFF.username, password: PASSWORD, role: 'staff' },
      starterToken,
    );
    rows.push(
      `${staff.status === 201 ? 'created' : 'exists '}  ${STAFF.username.padEnd(38)} staff of ${STAFF.company} (must NOT see the Migration Center)`,
    );
    console.log(rows.join('\n'));
    console.log(`\nPassword for every account: ${PASSWORD}`);
  } finally {
    await pg.end();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
}
