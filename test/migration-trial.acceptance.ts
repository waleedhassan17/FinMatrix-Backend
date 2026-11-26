/**
 * Migration Center × free trial, and commit concurrency
 * (npm run test:migration-trial).
 *
 * Against a running API and its database:
 *   - two owners' requests to commit the same batch at the same moment →
 *     exactly one commit; a commit racing an undo is refused;
 *   - a migration imported during a trial survives the trial being extended
 *     and converted (activation), balances unchanged;
 *   - after a trial ends the owner can still see the migration, download the
 *     certificate and undo it; a batch not yet imported is kept but cannot be
 *     imported until the company is active again — then it can.
 *
 * Environment: test/launch-helpers.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  BASE,
  check,
  code,
  data,
  DAY,
  Db,
  finish,
  owner,
  type Owner,
  req,
  section,
  startTrial,
  superAdmin,
  trialBalance,
} from './launch-helpers';

const FIX = path.join(__dirname, 'fixtures/migration');
const CUTOVER = '2026-06-30';

async function upload(token: string, batchId: string, file: string) {
  const form = new FormData();
  form.append('files', new Blob([fs.readFileSync(path.join(FIX, file))]), file);
  const r = await fetch(`${BASE}/migrations/${batchId}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

/** Create → upload the clean starter workbook → validate → sign off. */
async function readyBatch(o: Owner) {
  const b = data(
    await req('POST', '/migrations', {
      token: o.token,
      json: { sourceSystem: 'finmatrix_template', cutoverDate: CUTOVER },
    }),
  );
  await upload(o.token, b.id, 'a-clean-starter.xlsx');
  const v = data(
    await req('POST', `/migrations/${b.id}/validate`, {
      token: o.token,
      json: {},
    }),
  );
  const so = await req('POST', `/migrations/${b.id}/sign-off`, {
    token: o.token,
    json: { confirmed: true, spotCheckDone: true },
  });
  return {
    id: b.id as string,
    readiness: v?.readiness,
    signedOff: so.status === 200,
  };
}

async function main() {
  const db = await new Db().open();
  const admin = await superAdmin(db);
  console.log(`\n=== Migration × trial, concurrency — ${BASE} ===`);
  const asAdmin = (method: string, p: string, json?: unknown) =>
    req(method, p, { token: admin.token, json });
  const batchStatus = async (id: string) =>
    (await db.one(`SELECT status FROM migration_batches WHERE id = $1`, [id]))
      ?.status;

  // ── 1. Concurrency ───────────────────────────────────────────────────────
  section('1. two commits at once, commit racing undo');
  const T1 = await owner(db);
  await startTrial(T1);
  const a = await readyBatch(T1);
  check(
    'a clean batch is ready (100%) and signed off during the trial',
    a.readiness === 100 && a.signedOff,
    a,
  );
  const [c1, c2] = await Promise.all([
    req('POST', `/migrations/${a.id}/commit`, { token: T1.token, json: {} }),
    req('POST', `/migrations/${a.id}/commit`, { token: T1.token, json: {} }),
  ]);
  const statuses = [c1.status, c2.status].sort();
  const ledgerRows = (await trialBalance(db, T1.companyId)).lines;
  const tbOnce = await trialBalance(db, T1.companyId);
  check(
    'two simultaneous commits → exactly one import (200 + 409), posted once',
    statuses[0] === 200 &&
      statuses[1] === 409 &&
      (await batchStatus(a.id)) === 'committed' &&
      ledgerRows > 0,
    { statuses, codes: [code(c1), code(c2)], ledgerRows },
  );
  check('the migrated trial balance balances', tbOnce.d === tbOnce.c, tbOnce);
  const [rb, cAgain] = await Promise.all([
    req('POST', `/migrations/${a.id}/rollback`, { token: T1.token, json: {} }),
    req('POST', `/migrations/${a.id}/commit`, { token: T1.token, json: {} }),
  ]);
  const nonZero = await db.one(
    `SELECT count(*)::int AS n FROM (
       SELECT account_id FROM general_ledger WHERE company_id = $1
        GROUP BY account_id HAVING sum(debit - credit) <> 0) x`,
    [T1.companyId],
  );
  check(
    'a commit racing an undo is refused; the undo wins and every account nets to zero',
    rb.status === 200 && cAgain.status === 409 && nonZero.n === 0,
    { rollback: rb.status, commit: cAgain.status, code: code(cAgain), nonZero },
  );

  // ── 2. A migration survives the trial being extended and converted ───────
  section('2. imported during a trial: extension and conversion keep it');
  const b = await readyBatch(T1);
  const bc = await req('POST', `/migrations/${b.id}/commit`, {
    token: T1.token,
    json: {},
  });
  const tb0 = await trialBalance(db, T1.companyId);
  check(
    'imported during the trial',
    bc.status === 200 && tb0.lines > 0,
    bc.status,
  );
  await asAdmin('POST', `/admin/companies/${T1.companyId}/extend-trial`, {
    days: 5,
    reason: 'QA: migration help',
  });
  const tb1 = await trialBalance(db, T1.companyId);
  check(
    'after an extension: still imported, balances unchanged',
    (await batchStatus(b.id)) === 'committed' &&
      tb1.d === tb0.d &&
      tb1.lines === tb0.lines,
  );
  const act = data(
    await req('POST', `/companies/${T1.companyId}/activation-request`, {
      token: T1.token,
      json: { requestedPlan: 'warehouse_starter_6mo' },
    }),
  );
  await asAdmin(
    'PATCH',
    `/admin/payment-submissions/${act?.submissionId}/approve`,
    {
      endDate: new Date(Date.now() + 182 * DAY).toISOString(),
    },
  );
  const tb2 = await trialBalance(db, T1.companyId);
  const t1Row = await db.one(
    `SELECT trial_converted_at FROM companies WHERE id = $1`,
    [T1.companyId],
  );
  check(
    'after conversion: still imported, balances unchanged',
    !!t1Row.trial_converted_at &&
      (await batchStatus(b.id)) === 'committed' &&
      tb2.d === tb0.d &&
      tb2.lines === tb0.lines,
  );

  // ── 3. After a trial ends ────────────────────────────────────────────────
  section('3. trial ended: see, certificate, undo; a ready batch waits');
  const T2 = await owner(db);
  await startTrial(T2);
  const done = await readyBatch(T2);
  await req('POST', `/migrations/${done.id}/commit`, {
    token: T2.token,
    json: {},
  });
  await asAdmin('POST', `/admin/companies/${T2.companyId}/end-trial`, {
    reason: 'QA: trial over',
  });
  const see = await req('GET', `/migrations/${done.id}`, { token: T2.token });
  const cert = await fetch(`${BASE}/migrations/${done.id}/certificate`, {
    headers: { Authorization: `Bearer ${T2.token}` },
  });
  check(
    'the owner still sees the migration and its certificate',
    see.status === 200 && cert.status === 200,
    { see: see.status, cert: cert.status },
  );
  const undo = await req('POST', `/migrations/${done.id}/rollback`, {
    token: T2.token,
    json: {},
  });
  check(
    'undo works after the trial ended',
    undo.status === 200 && (await batchStatus(done.id)) === 'rolled_back',
    { status: undo.status, body: undo.body },
  );
  const fresh = await req('POST', '/migrations', {
    token: T2.token,
    json: { sourceSystem: 'finmatrix_template', cutoverDate: CUTOVER },
  });
  check(
    'a new migration cannot start while the trial is over (TRIAL_ENDED)',
    fresh.status === 403 && code(fresh) === 'TRIAL_ENDED',
  );

  // A batch prepared during the trial, imported only after activation.
  const T3 = await owner(db);
  await startTrial(T3);
  const waiting = await readyBatch(T3);
  await asAdmin('POST', `/admin/companies/${T3.companyId}/end-trial`, {
    reason: 'QA: trial over',
  });
  const blocked = await req('POST', `/migrations/${waiting.id}/commit`, {
    token: T3.token,
    json: {},
  });
  check(
    'a ready batch is kept but cannot be imported while the trial is over',
    blocked.status === 403 &&
      code(blocked) === 'TRIAL_ENDED' &&
      (await batchStatus(waiting.id)) === 'ready',
    { status: blocked.status, code: code(blocked) },
  );
  const act3 = data(
    await req('POST', `/companies/${T3.companyId}/activation-request`, {
      token: T3.token,
      json: {},
    }),
  );
  await asAdmin(
    'PATCH',
    `/admin/payment-submissions/${act3?.submissionId}/approve`,
    {
      plan: 'warehouse_starter_6mo',
      endDate: new Date(Date.now() + 182 * DAY).toISOString(),
    },
  );
  const later = await req('POST', `/migrations/${waiting.id}/commit`, {
    token: T3.token,
    json: {},
  });
  const tb3 = await trialBalance(db, T3.companyId);
  check(
    'after activation the kept batch imports, and the books balance',
    later.status === 200 &&
      (await batchStatus(waiting.id)) === 'committed' &&
      tb3.d === tb3.c &&
      tb3.lines > 0,
    { status: later.status, body: later.body },
  );

  // ── 4. Support ───────────────────────────────────────────────────────────
  section('4. support view and help request');
  const help = data(
    await req('POST', `/migrations/${waiting.id}/help-request`, {
      token: T3.token,
      json: { message: 'Please check my opening stock.' },
    }),
  );
  check(
    '"Ask for help" returns the batch reference',
    /^MIG-[0-9A-F]{8}$/.test(help?.reference ?? ''),
    help,
  );
  const view = data(await asAdmin('GET', `/admin/migrations/${waiting.id}`));
  check(
    'the admin view shows status, readiness, check totals — no rows',
    view?.status === 'committed' &&
      view?.readiness === 100 &&
      Array.isArray(view?.checks) &&
      view.checks.every((c: any) => c.details === undefined) &&
      !JSON.stringify(view).includes('staging'),
    Object.keys(view ?? {}),
  );
  const denied = await req('GET', `/admin/migrations/${waiting.id}`, {
    token: T3.token,
  });
  check('a company owner cannot use the admin view', denied.status === 403);

  await db.close();
  finish('Migration × trial');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
