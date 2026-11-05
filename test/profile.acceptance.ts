/**
 * FinMatrix — Self-service profile acceptance (PATCH /auth/me)
 * ============================================================
 * Against a running API, as a company owner:
 *
 *   1. PATCH /auth/me without a token is 401 (route exists, guarded)
 *   2. PATCH saves name + phone, normalising the phone to +92…, and answers
 *      with the /auth/me payload
 *   3. GET /auth/me reflects the change
 *   4. a bad phone and a one-letter name are 400 and change nothing
 *   5. a blank phone clears it
 *   6. the original name and phone are put back
 *
 * Usage (local, against a throwaway DB):
 *   API_BASE=http://localhost:3100/api/v1 ADMIN_EMAIL=… ADMIN_PASSWORD=… \
 *   npx ts-node -r tsconfig-paths/register test/profile.acceptance.ts
 *
 * Optional STAFF_USERNAME/STAFF_PASSWORD also checks a team member can edit
 * their own profile. Exits non-zero if any check fails.
 */
export {}; // isolate module scope (shares a tsconfig with acceptance.ts)

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@finmatrix.pk';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin123!';
const STAFF_USERNAME = process.env.STAFF_USERNAME;
const STAFF_PASSWORD = process.env.STAFF_PASSWORD;

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
const unwrap = (b: any) => b?.data ?? b;

async function signin(identifier: string, password: string): Promise<string | undefined> {
  const r = await req('POST', '/auth/signin', { identifier, password });
  const data = unwrap(r.body);
  return (data?.tokens ?? data)?.accessToken;
}

async function checkOwner() {
  console.log(`\n── owner (${ADMIN_EMAIL}) ──`);
  const token = await signin(ADMIN_EMAIL, ADMIN_PASSWORD);
  ok('owner signs in', !!token);
  if (!token) return;
  const auth = bearer(token);

  const before = unwrap((await req('GET', '/auth/me', undefined, auth)).body)?.user;
  ok('GET /auth/me returns the user', !!before?.id);
  if (!before) return;
  const original = { displayName: before.displayName as string, phone: before.phone as string | null };

  const anon = await req('PATCH', '/auth/me', { displayName: 'Nobody' });
  ok('PATCH /auth/me without a token is 401', anon.status === 401, `status=${anon.status}`);

  const upd = await req('PATCH', '/auth/me', { displayName: '  Profile   Test ', phone: '0312-4890176' }, auth);
  const updUser = unwrap(upd.body)?.user;
  ok('PATCH saves name + phone', upd.status === 200, `status=${upd.status} ${JSON.stringify(upd.body)}`);
  ok('name is tidied', updUser?.displayName === 'Profile Test', `got ${updUser?.displayName}`);
  ok('phone is stored as +92…', updUser?.phone === '+923124890176', `got ${updUser?.phone}`);
  ok('answers with the /auth/me shape (company + features)', 'company' in (unwrap(upd.body) ?? {}) && 'features' in (unwrap(upd.body) ?? {}));

  const me = unwrap((await req('GET', '/auth/me', undefined, auth)).body)?.user;
  ok('GET /auth/me reflects the change', me?.displayName === 'Profile Test' && me?.phone === '+923124890176');

  const badPhone = await req('PATCH', '/auth/me', { displayName: 'Profile Test', phone: '12345' }, auth);
  ok('a bad phone is 400', badPhone.status === 400, `status=${badPhone.status}`);
  const badName = await req('PATCH', '/auth/me', { displayName: 'A' }, auth);
  ok('a one-letter name is 400', badName.status === 400, `status=${badName.status}`);
  const still = unwrap((await req('GET', '/auth/me', undefined, auth)).body)?.user;
  ok('a refused edit changes nothing', still?.displayName === 'Profile Test' && still?.phone === '+923124890176');

  const cleared = unwrap((await req('PATCH', '/auth/me', { displayName: 'Profile Test', phone: '' }, auth)).body)?.user;
  ok('a blank phone clears it', cleared?.phone === null, `got ${cleared?.phone}`);

  const restored = await req(
    'PATCH',
    '/auth/me',
    { displayName: original.displayName, ...(original.phone ? { phone: original.phone } : {}) },
    auth,
  );
  const r = unwrap(restored.body)?.user;
  ok('original name and phone are restored', r?.displayName === original.displayName && (r?.phone ?? null) === (original.phone ?? null));
}

async function checkStaff() {
  if (!STAFF_USERNAME || !STAFF_PASSWORD) {
    console.log('\n── team member ── ~ skipped (STAFF_USERNAME/STAFF_PASSWORD not set)');
    return;
  }
  console.log(`\n── team member (${STAFF_USERNAME}) ──`);
  const token = await signin(STAFF_USERNAME, STAFF_PASSWORD);
  ok('team member signs in', !!token);
  if (!token) return;
  const auth = bearer(token);
  const before = unwrap((await req('GET', '/auth/me', undefined, auth)).body)?.user;
  const upd = await req('PATCH', '/auth/me', { displayName: 'Staff Profile Test' }, auth);
  ok('a team member can edit their own name', upd.status === 200 && unwrap(upd.body)?.user?.displayName === 'Staff Profile Test', `status=${upd.status}`);
  await req('PATCH', '/auth/me', { displayName: before.displayName, ...(before.phone ? { phone: before.phone } : {}) }, auth);
}

(async () => {
  console.log(`Profile acceptance against ${API}`);
  await checkOwner();
  await checkStaff();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
