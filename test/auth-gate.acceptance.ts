/**
 * FinMatrix — Auth / Account-Status Gate Acceptance (Phase1.md)
 * ============================================================
 * Verifies the server-side login gate and the Super-Admin company-review
 * endpoints against a running API. Non-destructive: it deactivates then
 * reactivates the ADMIN's company, leaving it active.
 *
 * Usage:
 *   API_BASE=https://finmatrix-api-prod-665c6b5cb6a1.herokuapp.com/api/v1 \
 *   ADMIN_EMAIL=metromatrix@gmail.com ADMIN_PASSWORD=123456 \
 *   SUPER_ADMIN_EMAIL=waleedhassansfd@gmail.com SUPER_ADMIN_PASSWORD='Waleed@104' \
 *   npx ts-node -r tsconfig-paths/register test/auth-gate.acceptance.ts
 *
 * Exits non-zero if any check fails.
 */
export {}; // isolate module scope (shares a tsconfig with acceptance.ts)

const API = process.env.API_BASE || 'https://finmatrix-api-prod-665c6b5cb6a1.herokuapp.com/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'metromatrix@gmail.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '123456';
const SA_EMAIL = process.env.SUPER_ADMIN_EMAIL || 'waleedhassansfd@gmail.com';
const SA_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || 'Waleed@104';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${detail}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function req(
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try { json = await res.json(); } catch { /* no body */ }
  return { status: res.status, body: json };
}

const tokenOf = (b: any) => b?.data?.tokens?.accessToken ?? '';
const codeOf = (b: any) => b?.error?.code ?? b?.code ?? '';
const signin = (email: string, password: string) =>
  req('POST', '/auth/signin', { email, password });

// Retry signin to ride out the login throttle window during the test.
async function signinRetry(email: string, password: string, tries = 6) {
  for (let i = 0; i < tries; i++) {
    const r = await signin(email, password);
    if (r.status !== 429 && codeOf(r.body) !== 'INTERNAL_ERROR') return r;
    await sleep(6000);
  }
  return signin(email, password);
}

async function main() {
  console.log(`\nAuth-gate acceptance → ${API}\n`);

  const sa = await signinRetry(SA_EMAIL, SA_PASSWORD);
  ok('super-admin can sign in', !!tokenOf(sa.body), `status=${sa.status}`);
  const saTok = tokenOf(sa.body);
  const saHdr = { Authorization: `Bearer ${saTok}` };

  const adminLogin = await signinRetry(ADMIN_EMAIL, ADMIN_PASSWORD);
  ok('active company admin can sign in', !!tokenOf(adminLogin.body));
  const adminTok = tokenOf(adminLogin.body);
  const companyId = adminLogin.body?.data?.companyId;
  ok('admin login returns a companyId', !!companyId);

  // Role guard: a company admin token must be rejected by /admin/companies.
  const forbid = await req('GET', '/admin/companies', undefined, {
    Authorization: `Bearer ${adminTok}`,
  });
  ok('non-super-admin → 403 on /admin/companies', forbid.status === 403, `got ${forbid.status}`);

  // Super-admin can list companies.
  const list = await req('GET', '/admin/companies?status=all&limit=50', undefined, saHdr);
  ok('super-admin can list companies', list.status === 200);

  // Deactivate → login blocked + existing session blocked.
  const deact = await req('PATCH', `/admin/companies/${companyId}/deactivate`, {}, saHdr);
  ok('super-admin can deactivate a company', deact.status === 200, `got ${deact.status}`);

  const blocked = await signinRetry(ADMIN_EMAIL, ADMIN_PASSWORD);
  ok('deactivated company cannot log in (COMPANY_INACTIVE)', codeOf(blocked.body) === 'COMPANY_INACTIVE',
    `code=${codeOf(blocked.body)}`);

  const guarded = await req('GET', '/accounts?search=1000', undefined, {
    Authorization: `Bearer ${adminTok}`,
    'x-company-id': companyId,
  });
  ok('existing session blocked on business endpoint (403)', guarded.status === 403, `got ${guarded.status}`);

  // Reactivate → login restored.
  const react = await req('PATCH', `/admin/companies/${companyId}/activate`, {}, saHdr);
  ok('super-admin can reactivate a company', react.status === 200);

  const restored = await signinRetry(ADMIN_EMAIL, ADMIN_PASSWORD);
  ok('reactivated company can log in again', !!tokenOf(restored.body),
    `code=${codeOf(restored.body)}`);

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
