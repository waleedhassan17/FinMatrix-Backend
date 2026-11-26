/**
 * FinMatrix — Auth / Account-Status Gate Acceptance (Phase1.md)
 * ============================================================
 * Verifies the server-side login gate and the super-admin company-review
 * endpoints against a running API, on accounts it creates for the run: a
 * throwaway super-admin and an owner with a company on a trial.
 *
 * Usage (a scratch database — never production):
 *   API_BASE=http://localhost:3101/api/v1 \
 *   DATABASE_URL=postgres://finmatrix_user:…@localhost:5432/finmatrix_launch \
 *   npm run test:authgate
 *
 * It used to default to the production API and sign in to real accounts
 * with passwords written in this file, then deactivate a real company. The
 * defaults are local now, and there are no credentials in the file.
 *
 * Since launch, "deactivate" is a suspension: the owner is refused at sign-in
 * with COMPANY_SUSPENDED and every live session is refused at the next
 * request; "activate" reinstates it. Exits non-zero if any check fails.
 */
import {
  BASE,
  code,
  data,
  Db,
  owner,
  PASSWORD,
  req,
  startTrial,
  superAdmin,
} from './launch-helpers';

let pass = 0;
let fail = 0;
const ok = (name: string, cond: boolean, detail = '') => {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name} ${detail}`);
  }
};

async function main() {
  console.log(`\nAuth-gate acceptance → ${BASE}\n`);
  const db = await new Db().open();

  const sa = await superAdmin(db);
  ok('super-admin can sign in', !!sa.token);

  const o = await owner(db);
  const trial = await startTrial(o);
  ok(
    'owner starts a trial (company active)',
    trial.status === 201 || trial.status === 200,
    `got ${trial.status}`,
  );

  const first = await req('POST', '/auth/signin', {
    ip: o.ip,
    json: { email: o.email, password: PASSWORD },
  });
  const adminTok = data(first)?.tokens?.accessToken as string;
  ok('active company owner can sign in', !!adminTok);
  ok('sign-in returns the companyId', data(first)?.companyId === o.companyId);

  // Role guard: a company owner's token is refused on the console endpoints.
  const forbid = await req('GET', '/admin/companies', { token: adminTok });
  ok(
    'non-super-admin → 403 on /admin/companies',
    forbid.status === 403,
    `got ${forbid.status}`,
  );

  const list = await req('GET', '/admin/companies?status=all&limit=50', {
    token: sa.token,
  });
  ok(
    'super-admin can list companies',
    list.status === 200,
    `got ${list.status}`,
  );

  // Deactivate = suspend.
  const deact = await req(
    'PATCH',
    `/admin/companies/${o.companyId}/deactivate`,
    {
      token: sa.token,
      json: { reason: 'Auth-gate acceptance' },
    },
  );
  ok(
    'super-admin can deactivate (suspend) a company',
    deact.status === 200,
    `got ${deact.status}`,
  );

  const blocked = await req('POST', '/auth/signin', {
    ip: o.ip,
    json: { email: o.email, password: PASSWORD },
  });
  ok(
    'suspended company: sign-in refused with COMPANY_SUSPENDED',
    blocked.status === 403 && code(blocked) === 'COMPANY_SUSPENDED',
    `status=${blocked.status} code=${code(blocked)}`,
  );

  const guarded = await req('GET', '/accounts?search=1000', {
    token: adminTok,
    companyId: o.companyId,
  });
  ok(
    'existing session refused on a business endpoint (403 COMPANY_SUSPENDED)',
    guarded.status === 403 && code(guarded) === 'COMPANY_SUSPENDED',
    `got ${guarded.status} ${code(guarded)}`,
  );

  // Activate = reinstate.
  const react = await req('PATCH', `/admin/companies/${o.companyId}/activate`, {
    token: sa.token,
    json: {},
  });
  ok(
    'super-admin can reactivate (reinstate) the company',
    react.status === 200,
    `got ${react.status}`,
  );

  const restored = await req('POST', '/auth/signin', {
    ip: o.ip,
    json: { email: o.email, password: PASSWORD },
  });
  ok(
    'reinstated company can sign in again',
    !!data(restored)?.tokens?.accessToken,
    `code=${code(restored)}`,
  );
  const back = await req('GET', '/accounts?search=1000', {
    token: data(restored)?.tokens?.accessToken,
    companyId: o.companyId,
  });
  ok(
    '…and use the books again',
    back.status === 200,
    `got ${back.status} ${code(back)}`,
  );

  const row = await db.one(
    `SELECT status, suspended_at FROM companies WHERE id = $1`,
    [o.companyId],
  );
  ok(
    'status restored, suspension cleared',
    row.status !== 'suspended' && row.suspended_at === null,
    JSON.stringify(row),
  );

  await db.close();
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
