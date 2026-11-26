/**
 * Account control — suspend and delete (npm run test:account-admin).
 *
 * Proves, against a running API and its database:
 *   - suspending a user ends their session on the NEXT request, and sign-in,
 *     refresh, password reset and OTP all answer ACCOUNT_SUSPENDED; reinstating
 *     restores access (old tokens stay revoked);
 *   - suspending a company blocks every member, while a member of another
 *     company keeps that one;
 *   - deleting a company removes every row in every registered table and its
 *     stored files, while another company's data is byte-for-byte unchanged
 *     (and its Trial Balance and A = L + E with it); every table in the schema
 *     is classified by the registry;
 *   - the same email, username and phone can register again; the trial rule
 *     follows the "allow a new free trial" choice;
 *   - safeguards: typed confirmation, super-admins and yourself untouchable,
 *     sole owners refused, bulk delete for demo accounts only;
 *   - the final backup: taken for a company with posted entries, downloadable
 *     by a super-admin only, expired after its retention; the platform audit
 *     record survives the deletion.
 *
 * Environment: test/launch-helpers.ts. The API must run its deletion worker
 * (ACCOUNT_DELETION_WORKER_ENABLED not false) and its export worker.
 */
import {
  COMPANY_DATA_REGISTRY,
  NON_COMPANY_TABLES,
  registeredTableNames,
} from '../src/common/company-data/company-data.registry';
import {
  BASE,
  check,
  code,
  data,
  Db,
  finish,
  freshIp,
  owner,
  type Owner,
  PASSWORD,
  req,
  RUN,
  section,
  signin,
  sleep,
  startTrial,
  superAdmin,
  trialBalance,
} from './launch-helpers';

async function main() {
  const db = await new Db().open();
  const admin = await superAdmin(db);
  const admin2 = await superAdmin(db);
  console.log(`\n=== Account control (suspend / delete) — ${BASE} ===`);

  const asAdmin = (method: string, path: string, json?: unknown) =>
    req(method, path, { token: admin.token, json });
  const company = (id: string) =>
    db.one(`SELECT * FROM companies WHERE id = $1`, [id]);

  const companyTables = COMPANY_DATA_REGISTRY.filter(
    (e) => e.scope === 'company',
  ).map((e) => e.table);
  const presentTables = new Set(
    (
      await db.sql<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
      )
    ).map((r) => r.table_name),
  );
  /** md5 of every row a company owns, per registered table. */
  async function fingerprint(companyId: string) {
    const out: Record<string, string> = {};
    for (const t of companyTables) {
      if (!presentTables.has(t)) continue;
      const [row] = await db.sql(
        `SELECT md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS h,
                count(*)::int AS n
           FROM "${t}" x WHERE company_id = $1`,
        [companyId],
      );
      out[t] = `${row.n}:${row.h}`;
    }
    return out;
  }
  /**
   * Rows still mentioning the company. Child tables have no company_id; they
   * are checked through the parent ids recorded before the deletion.
   */
  async function rowsLeft(companyId: string) {
    const left: Record<string, number> = {};
    for (const e of COMPANY_DATA_REGISTRY) {
      if (!presentTables.has(e.table)) continue;
      let n = 0;
      if (e.scope === 'company') {
        n = Number(
          (
            await db.one(
              `SELECT count(*)::int AS n FROM "${e.table}" WHERE company_id = $1`,
              [companyId],
            )
          ).n,
        );
      } else if (e.scope === 'platform' && e.handling === 'null-columns') {
        for (const col of e.columns ?? []) {
          n += Number(
            (
              await db.one(
                `SELECT count(*)::int AS n FROM "${e.table}" WHERE "${col}" = $1`,
                [companyId],
              )
            ).n,
          );
        }
      }
      if (n) left[e.table] = n;
    }
    return left;
  }
  async function waitDeletion(id: string, ms = 120_000) {
    const deadline = Date.now() + ms;
    for (;;) {
      const r = data(await asAdmin('GET', `/admin/company-deletions/${id}`));
      if (r?.status === 'done' || r?.status === 'failed') return r;
      if (Date.now() > deadline) return r;
      await sleep(500);
    }
  }
  /** Post one balanced journal entry: debit cash, credit equity. */
  async function postEntry(o: Owner, amount: string) {
    const accs =
      data(await req('GET', '/accounts', { token: o.token }))?.accounts ?? [];
    const cash =
      accs.find((a: any) => a.type === 'asset' && /cash/i.test(a.name)) ??
      accs.find((a: any) => a.type === 'asset');
    const equity =
      accs.find(
        (a: any) => a.type === 'equity' && /capital|owner/i.test(a.name),
      ) ?? accs.find((a: any) => a.type === 'equity');
    return req('POST', '/journal-entries', {
      token: o.token,
      json: {
        date: new Date().toISOString().slice(0, 10),
        memo: `QA ${amount}`,
        status: 'posted',
        lines: [
          { accountId: cash.id, debit: amount, credit: '0.0000' },
          { accountId: equity.id, debit: '0.0000', credit: amount },
        ],
      },
    });
  }
  async function balanceSheet(companyId: string) {
    const rows = await db.sql(
      `SELECT a.type, coalesce(sum(g.debit - g.credit), 0)::text AS net
         FROM general_ledger g JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id = $1 GROUP BY a.type ORDER BY a.type`,
      [companyId],
    );
    return JSON.stringify(rows);
  }

  // ── 0. Every table is classified ─────────────────────────────────────────
  section('0. registry covers the schema');
  const unclassified = [...presentTables].filter(
    (t) => !registeredTableNames().has(t),
  );
  check(
    'every table in the public schema is classified',
    unclassified.length === 0,
    unclassified,
  );
  const withCompanyId = (
    await db.sql<{ table_name: string }>(
      `SELECT DISTINCT table_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = 'company_id'`,
    )
  ).map((r) => r.table_name);
  const notRegistered = withCompanyId.filter(
    (t) => !COMPANY_DATA_REGISTRY.some((e) => e.table === t),
  );
  check(
    'every table with company_id is in the registry',
    notRegistered.length === 0,
    notRegistered,
  );
  check(
    'the registry and the non-company list do not overlap',
    NON_COMPANY_TABLES.every(
      (t) => !COMPANY_DATA_REGISTRY.some((e) => e.table === t),
    ),
  );

  // ── 1. Suspend a user ────────────────────────────────────────────────────
  section('1. suspend a user');
  const S = await owner(db);
  await startTrial(S);
  const sRefresh = data(
    await req('POST', '/auth/signin', {
      ip: freshIp(),
      json: { email: S.email, password: PASSWORD },
    }),
  )?.tokens;
  check(
    'owner works before suspension',
    (await req('GET', '/accounts', { token: S.token })).status === 200,
  );
  const noReason = await asAdmin('PATCH', `/admin/users/${S.userId}/suspend`, {
    reason: '',
  });
  check('suspend needs a reason', noReason.status === 400, noReason.status);
  const sus = await asAdmin('PATCH', `/admin/users/${S.userId}/suspend`, {
    reason: 'QA: chargeback',
  });
  check('suspend → 200', sus.status === 200, sus.body);
  const next = await req('GET', '/accounts', { token: S.token });
  check(
    'the existing access token fails on the NEXT request (ACCOUNT_SUSPENDED)',
    next.status === 401 && code(next) === 'ACCOUNT_SUSPENDED',
    { status: next.status, code: code(next) },
  );
  const ref = await req('POST', '/auth/refresh-token', {
    json: { refreshToken: sRefresh?.refreshToken },
  });
  check('refresh fails', ref.status === 401, {
    status: ref.status,
    code: code(ref),
  });
  const sIn = await req('POST', '/auth/signin', {
    ip: freshIp(),
    json: { email: S.email, password: PASSWORD },
  });
  check(
    'sign-in → 403 ACCOUNT_SUSPENDED',
    sIn.status === 403 && code(sIn) === 'ACCOUNT_SUSPENDED',
    { status: sIn.status, code: code(sIn) },
  );
  const wrongPw = await req('POST', '/auth/signin', {
    ip: freshIp(),
    json: { email: S.email, password: 'wrong-password' },
  });
  check(
    '… but a wrong password learns nothing (INVALID_CREDENTIALS)',
    code(wrongPw) === 'INVALID_CREDENTIALS',
    code(wrongPw),
  );
  const forgot = await req('POST', '/auth/forgot-password', {
    ip: freshIp(),
    json: { email: S.email },
  });
  check(
    'password reset → ACCOUNT_SUSPENDED',
    code(forgot) === 'ACCOUNT_SUSPENDED',
    { status: forgot.status, code: code(forgot) },
  );
  const otp = await req('POST', '/auth/verify-otp', {
    ip: freshIp(),
    json: { email: S.email, otp: '123456' },
  });
  check(
    'OTP → ACCOUNT_SUSPENDED',
    code(otp) === 'ACCOUNT_SUSPENDED',
    code(otp),
  );
  const resend = await req('POST', '/auth/resend-verification', {
    ip: freshIp(),
    json: { email: S.email },
  });
  check(
    'verification resend → ACCOUNT_SUSPENDED',
    code(resend) === 'ACCOUNT_SUSPENDED',
    code(resend),
  );
  const sAudit = await db.one(
    `SELECT * FROM platform_audit_events WHERE action = 'user_suspended' AND target_id = $1`,
    [S.userId],
  );
  check('suspension audited with reason', sAudit?.reason === 'QA: chargeback');
  const rein = await asAdmin('PATCH', `/admin/users/${S.userId}/reinstate`);
  const oldToken = await req('GET', '/accounts', { token: S.token });
  const freshToken = await signin(S.email);
  check(
    'reinstate → old tokens stay revoked (SESSION_REVOKED)',
    rein.status === 200 && code(oldToken) === 'SESSION_REVOKED',
    code(oldToken),
  );
  check(
    '… and a new sign-in works',
    (await req('GET', '/accounts', { token: freshToken })).status === 200,
  );

  // ── 2. Suspend a company ─────────────────────────────────────────────────
  section('2. suspend a company');
  const C1 = await owner(db);
  await startTrial(C1);
  const C2 = await owner(db);
  await startTrial(C2);
  // C2's owner also belongs to C1 (joins with the invite code).
  const c1Row = await company(C1.companyId);
  const join = await req('POST', '/companies/join', {
    token: C2.token,
    json: { code: c1Row.invite_code },
  });
  check('a second company member joins C1', join.status === 201, join.body);
  const cs = await asAdmin(
    'PATCH',
    `/admin/companies/${C1.companyId}/suspend`,
    { reason: 'QA: unpaid' },
  );
  check('suspend company → 200', cs.status === 200, cs.body);
  const c1Owner = await req('GET', '/accounts', { token: C1.token });
  check(
    'every member is blocked (COMPANY_SUSPENDED)',
    c1Owner.status === 403 && code(c1Owner) === 'COMPANY_SUSPENDED',
    code(c1Owner),
  );
  const c1In = await req('POST', '/auth/signin', {
    ip: freshIp(),
    json: { email: C1.email, password: PASSWORD },
  });
  check(
    'the only-company owner cannot sign in (COMPANY_SUSPENDED)',
    code(c1In) === 'COMPANY_SUSPENDED',
    code(c1In),
  );
  await db.sql(`UPDATE users SET default_company_id = $2 WHERE id = $1`, [
    C2.userId,
    C1.companyId,
  ]);
  const c2In = data(
    await req('POST', '/auth/signin', {
      ip: freshIp(),
      json: { email: C2.email, password: PASSWORD },
    }),
  );
  check(
    'a member of another company signs in to that one instead',
    c2In?.companyId === C2.companyId,
    c2In?.companyId,
  );
  const back = await asAdmin(
    'PATCH',
    `/admin/companies/${C1.companyId}/reinstate`,
  );
  const c1Again = await req('GET', '/accounts', {
    token: await signin(C1.email),
  });
  check(
    'reinstate → restored exactly (trial still running)',
    back.status === 200 &&
      c1Again.status === 200 &&
      (await company(C1.companyId)).subscription_plan === 'warehouse_trial',
  );

  // ── 3. Safeguards ────────────────────────────────────────────────────────
  section('3. safeguards');
  const supSus = await asAdmin('PATCH', `/admin/users/${admin2.id}/suspend`, {
    reason: 'try it',
  });
  check(
    'a super-admin cannot be suspended',
    supSus.status === 403 && code(supSus) === 'CANNOT_TARGET_SUPER_ADMIN',
    code(supSus),
  );
  const supDel = await req('DELETE', `/admin/users/${admin2.id}`, {
    token: admin.token,
    json: { confirmEmail: admin2.email, reason: 'try it' },
  });
  check(
    'a super-admin cannot be deleted',
    supDel.status === 403,
    supDel.status,
  );
  const self = await asAdmin('PATCH', `/admin/users/${admin.id}/suspend`, {
    reason: 'try it',
  });
  check('an admin cannot target themselves', self.status === 403, code(self));
  const sole = await req('DELETE', `/admin/users/${C1.userId}`, {
    token: admin.token,
    json: { confirmEmail: C1.email, reason: 'QA test' },
  });
  check(
    'deleting a sole owner as a user is refused (SOLE_OWNER)',
    sole.status === 409 && code(sole) === 'SOLE_OWNER',
    code(sole),
  );
  const wrong = await req('DELETE', `/admin/companies/${C1.companyId}`, {
    token: admin.token,
    json: { confirmName: 'not the name', reason: 'QA test' },
  });
  check(
    'wrong confirmation text is rejected',
    wrong.status === 400 && code(wrong) === 'CONFIRMATION_MISMATCH',
    code(wrong),
  );
  const ownerTries = await req('DELETE', `/admin/companies/${C1.companyId}`, {
    token: C1.token,
    json: { confirmName: c1Row.name, reason: 'mine' },
  });
  check(
    'a company owner cannot reach admin deletion',
    ownerTries.status === 403,
  );
  const bulkBad = await asAdmin('POST', '/admin/companies/bulk', {
    action: 'delete',
    ids: [C1.companyId],
    reason: 'QA bulk',
  });
  check(
    'bulk delete refuses non-demo companies',
    bulkBad.status === 400 && code(bulkBad) === 'BULK_DELETE_DEMO_ONLY',
    code(bulkBad),
  );

  // ── 4. Delete a company (not demo, posted entries → final backup) ────────
  section('4. delete a company');
  const Del = await owner(db, { taxId: `${Date.now() % 1e8}5` });
  await startTrial(Del);
  // A stored file (db:) — a migration upload — and a backup ZIP on disk.
  const batch = data(
    await req('POST', '/migrations', {
      token: Del.token,
      json: {
        sourceSystem: 'finmatrix_template',
        cutoverDate: new Date().toISOString().slice(0, 10),
      },
    }),
  );
  const tpl = await fetch(`${BASE}/migrations/template`, {
    headers: { Authorization: `Bearer ${Del.token}` },
  });
  const fd = new FormData();
  fd.append(
    'files',
    new Blob([Buffer.from(await tpl.arrayBuffer())]),
    'starter.xlsx',
  );
  await fetch(`${BASE}/migrations/${batch?.id}/files`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${Del.token}` },
    body: fd as any,
  });
  const je = await postEntry(Del, '12500.0000');
  check('the victim has posted books', je.status === 201, je.body);
  await req('POST', '/data-portability/exports', {
    token: Del.token,
    json: { includeXlsx: false },
  });
  for (let i = 0; i < 60; i++) {
    const ex = await db.one(
      `SELECT status FROM company_exports WHERE company_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [Del.companyId],
    );
    if (ex?.status === 'ready' || ex?.status === 'failed') break;
    await sleep(1000);
  }
  const fileKeys = (
    await db.sql(
      `SELECT storage_key AS k FROM migration_files WHERE company_id = $1 AND storage_key IS NOT NULL
       UNION ALL SELECT storage_key FROM company_exports WHERE company_id = $1 AND storage_key IS NOT NULL`,
      [Del.companyId],
    )
  ).map((r: any) => r.k as string);
  check(
    'the victim holds stored files (db: and disk)',
    fileKeys.some((k) => k.startsWith('db:')) &&
      fileKeys.some((k) => !k.startsWith('db:')),
    fileKeys,
  );
  // Children reached only through a parent: record their parent ids.
  const victimJes = (
    await db.sql(`SELECT id FROM journal_entries WHERE company_id = $1`, [
      Del.companyId,
    ])
  ).map((r: any) => r.id);

  // The bystander: another company with books.
  const By = await owner(db);
  await startTrial(By);
  await postEntry(By, '777.0000');
  const byFp = await fingerprint(By.companyId);
  const byTb = await trialBalance(db, By.companyId);
  const byBs = await balanceSheet(By.companyId);

  const preview = data(
    await asAdmin('GET', `/admin/companies/${Del.companyId}/deletion-preview`),
  );
  check(
    'deletion preview: row counts, files, final backup required',
    preview?.rowCounts?.journal_entries >= 1 &&
      preview?.files >= 2 &&
      preview?.finalBackup === true &&
      preview?.allowNewTrialDefault === false,
    preview,
  );
  const delName = (await company(Del.companyId)).name;
  const delReq = await req('DELETE', `/admin/companies/${Del.companyId}`, {
    token: admin.token,
    json: { confirmName: delName, reason: 'QA: deletion test' },
  });
  check(
    'DELETE → 202 with a job',
    delReq.status === 202 && !!data(delReq)?.id,
    delReq.body,
  );
  const job = await waitDeletion(data(delReq)?.id);
  check('the deletion job finishes', job?.status === 'done', job);
  check('the company row is gone', !(await company(Del.companyId)));
  const left = await rowsLeft(Del.companyId);
  check(
    'zero rows remain in every registered table',
    Object.keys(left).length === 0,
    left,
  );
  const orphanLines = await db.one(
    `SELECT count(*)::int AS n FROM journal_entry_lines WHERE entry_id = ANY($1::uuid[])`,
    [victimJes],
  );
  check(
    'children went with their parents (journal lines)',
    orphanLines.n === 0,
    orphanLines,
  );
  const dbFiles = fileKeys
    .filter((k) => k.startsWith('db:'))
    .map((k) => k.slice(3));
  const dbLeft = await db.one(
    `SELECT count(*)::int AS n FROM stored_files WHERE id = ANY($1::uuid[])`,
    [dbFiles],
  );
  check('stored files in Postgres are deleted', dbLeft.n === 0, dbLeft);
  check(
    'stored files on disk/Cloudinary counted as deleted',
    (job?.filesDeleted ?? 0) >= fileKeys.length && job?.filesFailed === 0,
    job,
  );
  const userLeft = await db.one(
    `SELECT count(*)::int AS n FROM users WHERE id = $1`,
    [Del.userId],
  );
  check('the owner (only this company) is deleted', userLeft.n === 0);
  check(
    'the bystander company is byte-for-byte unchanged',
    JSON.stringify(await fingerprint(By.companyId)) === JSON.stringify(byFp),
  );
  const byTb2 = await trialBalance(db, By.companyId);
  check(
    '… its Trial Balance balances and is unchanged',
    byTb2.d === byTb.d && byTb2.c === byTb.c && byTb2.d === byTb2.c,
    { byTb, byTb2 },
  );
  check(
    '… and its balance sheet (A = L + E) is unchanged',
    (await balanceSheet(By.companyId)) === byBs,
  );
  const delAudit = await db.one(
    `SELECT * FROM platform_audit_events WHERE action = 'company_deleted' AND company_id = $1`,
    [Del.companyId],
  );
  check(
    'the platform audit record survives: who, name, email hash, row counts, reason',
    delAudit?.actor_user_id === admin.id &&
      delAudit?.company_name === delName &&
      /^[0-9a-f]{64}$/.test(delAudit?.details?.ownerEmailHash ?? '') &&
      delAudit?.details?.rowCounts?.journal_entries >= 1 &&
      delAudit?.reason === 'QA: deletion test',
    delAudit,
  );

  // Final backup.
  const log = data(await asAdmin('GET', '/admin/deleted-accounts'));
  const entry = (log ?? []).find((e: any) => e.companyId === Del.companyId);
  check(
    'deleted-accounts log lists it with a downloadable final backup',
    !!entry?.finalBackup?.id,
    entry,
  );
  const dl = await fetch(
    `${BASE}/admin/deleted-accounts/backups/${entry?.finalBackup?.id}/download`,
    { headers: { Authorization: `Bearer ${admin.token}` } },
  );
  const zip = Buffer.from(await dl.arrayBuffer());
  check(
    'a super-admin downloads the final backup (a ZIP)',
    dl.status === 200 && zip.subarray(0, 2).toString() === 'PK',
    { status: dl.status, bytes: zip.length },
  );
  const dlOwner = await fetch(
    `${BASE}/admin/deleted-accounts/backups/${entry?.finalBackup?.id}/download`,
    { headers: { Authorization: `Bearer ${By.token}` } },
  );
  check('… nobody else can', dlOwner.status === 403, dlOwner.status);
  await db.sql(
    `UPDATE platform_final_backups SET expires_at = now() - interval '1 minute' WHERE id = $1`,
    [entry?.finalBackup?.id],
  );
  const sweep = data(
    await asAdmin('POST', '/admin/deleted-accounts/run-backup-sweep'),
  );
  const gone = await fetch(
    `${BASE}/admin/deleted-accounts/backups/${entry?.finalBackup?.id}/download`,
    { headers: { Authorization: `Bearer ${admin.token}` } },
  );
  const bRow = await db.one(
    `SELECT * FROM platform_final_backups WHERE id = $1`,
    [entry?.finalBackup?.id],
  );
  check(
    'after its retention the backup is deleted',
    sweep?.deleted >= 1 &&
      gone.status === 404 &&
      !!bRow?.deleted_at &&
      bRow?.storage_key === null,
    { sweep, status: gone.status },
  );

  // ── 5. Email reuse and trial history ─────────────────────────────────────
  section('5. the same email registers again; trial history');
  const again = await owner(db, { email: Del.email, phone: Del.phone });
  check(
    'the same email and phone sign up and set up a company again',
    !!again.companyId,
  );
  const againTrial = await startTrial(again);
  check(
    'without "allow a new trial": the re-registered owner cannot trial',
    againTrial.status === 409 &&
      ['TRIAL_EMAIL_USED', 'TRIAL_PHONE_USED', 'TRIAL_TAX_ID_USED'].includes(
        againTrial.body?.error?.details?.reason,
      ),
    againTrial.body,
  );
  // Now a demo company deleted WITH a new trial allowed (the demo default).
  const Demo = await owner(db);
  await startTrial(Demo);
  await asAdmin('PATCH', `/admin/companies/${Demo.companyId}/demo`, {
    isDemo: true,
  });
  const demoPrev = data(
    await asAdmin('GET', `/admin/companies/${Demo.companyId}/deletion-preview`),
  );
  check(
    'a demo company: no final backup, new trial allowed by default',
    demoPrev?.finalBackup === false && demoPrev?.allowNewTrialDefault === true,
    demoPrev,
  );
  const bulk = data(
    await asAdmin('POST', '/admin/companies/bulk', {
      action: 'delete',
      ids: [Demo.companyId],
      reason: 'QA demo cleanup',
    }),
  );
  const demoJob = await waitDeletion(bulk?.jobs?.[0]?.id);
  check(
    'bulk delete of a demo company completes',
    demoJob?.status === 'done',
    demoJob,
  );
  const demoAgain = await owner(db, { email: Demo.email, phone: Demo.phone });
  const demoTrial = await startTrial(demoAgain);
  check(
    'with "allow a new trial": the same email and phone can trial again',
    demoTrial.status === 201,
    demoTrial.body,
  );
  // A rider (non-owner) user deleted on their own.
  const riderEmail = `delrider_${RUN}@example.com`;
  await req('POST', '/auth/signup', {
    ip: freshIp(),
    json: {
      email: riderEmail,
      password: PASSWORD,
      displayName: 'QA Del Rider',
      role: 'delivery',
      companyCode: (await company(By.companyId)).invite_code,
    },
  });
  const rider = await db.one(`SELECT id FROM users WHERE email = $1`, [
    riderEmail,
  ]);
  const rDel = await req('DELETE', `/admin/users/${rider.id}`, {
    token: admin.token,
    json: { confirmEmail: riderEmail, reason: 'QA: left the company' },
  });
  const rGone = await db.one(
    `SELECT count(*)::int AS n FROM users WHERE id = $1`,
    [rider.id],
  );
  const rUser = await req('POST', '/auth/signup', {
    ip: freshIp(),
    json: {
      email: riderEmail,
      password: PASSWORD,
      displayName: 'QA Del Rider again',
      role: 'admin',
    },
  });
  check(
    'a user is deleted, and their email registers again',
    rDel.status === 200 && rGone.n === 0 && rUser.status === 201,
    { del: rDel.status, again: rUser.status },
  );

  await db.close();
  finish('Account control');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
