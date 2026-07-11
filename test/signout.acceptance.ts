/**
 * FinMatrix — Sign-Out Acceptance (signout.md)
 * ============================================
 * Verifies, for EACH of the three user types (company administrator,
 * delivery personnel, super admin), against a running API:
 *
 *   1. signin issues a token pair; /auth/me works with the access token
 *   2. POST /auth/logout returns 200
 *   3. the OLD access token is now rejected (401) — jti denylist
 *   4. the OLD refresh token is now rejected (401) — server-side revocation
 *   5. logout is idempotent: repeating it with the same (now-dead) token
 *      still returns 200 and leaks nothing
 *   6. a fresh signin issues a new, working token
 *   7. '/auth/signout' alias behaves identically (checked once)
 *
 * Non-destructive: only the caller's own tokens are revoked.
 *
 * Usage (local):
 *   API_BASE=http://localhost:3000/api/v1 \
 *   npx ts-node -r tsconfig-paths/register test/signout.acceptance.ts
 *
 * Roles with missing credentials are skipped (envs: ADMIN_EMAIL/ADMIN_PASSWORD,
 * DELIVERY_EMAIL/DELIVERY_PASSWORD, SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD).
 * Exits non-zero if any check fails.
 */
export {}; // isolate module scope (shares a tsconfig with acceptance.ts)

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';

const ROLES: Array<{ name: string; email?: string; password?: string }> = [
  {
    name: 'company administrator',
    email: process.env.ADMIN_EMAIL || 'admin@finmatrix.pk',
    password: process.env.ADMIN_PASSWORD || 'Admin123!',
  },
  {
    name: 'delivery personnel',
    email: process.env.DELIVERY_EMAIL || 'imran@finmatrix.pk',
    password: process.env.DELIVERY_PASSWORD || 'Delivery123!',
  },
  {
    name: 'super admin',
    email: process.env.SUPER_ADMIN_EMAIL || 'waleedhassansfd@gmail.com',
    password: process.env.SUPER_ADMIN_PASSWORD || 'Waleed@104',
  },
];

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
  try { parsed = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: parsed };
}

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });

async function signin(email: string, password: string) {
  const r = await req('POST', '/auth/signin', { email, password });
  const data = r.body?.data ?? r.body;
  const tokens = data?.tokens ?? data;
  return {
    status: r.status,
    accessToken: tokens?.accessToken as string | undefined,
    refreshToken: tokens?.refreshToken as string | undefined,
  };
}

async function runRole(role: { name: string; email?: string; password?: string }, checkAlias: boolean) {
  console.log(`\n── ${role.name} (${role.email}) ──`);
  if (!role.email || !role.password) {
    console.log('  ~ skipped (no credentials provided)');
    return;
  }

  // 1. signin + me
  const s1 = await signin(role.email, role.password);
  ok('signin issues an access + refresh pair', s1.status === 200 && !!s1.accessToken && !!s1.refreshToken, `status=${s1.status}`);
  if (!s1.accessToken || !s1.refreshToken) return;

  const me1 = await req('GET', '/auth/me', undefined, bearer(s1.accessToken));
  ok('/auth/me works before logout', me1.status === 200, `status=${me1.status}`);

  // 2. logout
  const lo = await req('POST', '/auth/logout', undefined, bearer(s1.accessToken));
  ok('POST /auth/logout returns 200', lo.status === 200, `status=${lo.status}`);

  // 3. old access token now rejected
  const me2 = await req('GET', '/auth/me', undefined, bearer(s1.accessToken));
  ok('old access token is rejected after logout (401)', me2.status === 401, `status=${me2.status}`);

  // 4. old refresh token now rejected
  const rf = await req('POST', '/auth/refresh-token', { refreshToken: s1.refreshToken });
  ok('old refresh token is rejected after logout (401)', rf.status === 401, `status=${rf.status}`);

  // 5. idempotent: logging out again with the dead token still succeeds
  const lo2 = await req('POST', '/auth/logout', undefined, bearer(s1.accessToken));
  ok('repeated logout with a dead token still returns 200 (idempotent)', lo2.status === 200, `status=${lo2.status}`);

  // 6. fresh signin issues a new working token
  const s2 = await signin(role.email, role.password);
  const me3 = s2.accessToken
    ? await req('GET', '/auth/me', undefined, bearer(s2.accessToken))
    : { status: 0 };
  ok('a fresh signin issues a new working token', s2.status === 200 && me3.status === 200, `signin=${s2.status} me=${me3.status}`);

  // 7. '/auth/signout' alias (once is enough)
  if (checkAlias && s2.accessToken) {
    const alias = await req('POST', '/auth/signout', undefined, bearer(s2.accessToken));
    const meAfter = await req('GET', '/auth/me', undefined, bearer(s2.accessToken));
    ok("'/auth/signout' alias also revokes the token", alias.status === 200 && meAfter.status === 401, `signout=${alias.status} me=${meAfter.status}`);
  } else if (s2.accessToken) {
    // leave no live session behind
    await req('POST', '/auth/logout', undefined, bearer(s2.accessToken));
  }

  // logout with no Authorization header at all is still a 200 no-op
  const bare = await req('POST', '/auth/logout');
  ok('logout without a token is a 200 no-op', bare.status === 200, `status=${bare.status}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`Sign-out acceptance against ${API}`);
  let first = true;
  for (const role of ROLES) {
    if (!first) {
      // /auth/signin is throttled at 5/min; keep each role in its own window.
      console.log('  … waiting out the signin rate-limit window');
      await sleep(61_000);
    }
    await runRole(role, first);
    first = false;
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('Fatal:', e);
  process.exit(1);
});
