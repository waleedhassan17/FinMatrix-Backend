/**
 * Migration Center — a Peachtree backup through the real HTTP routes.
 * ====================================================================
 * The in-process suite (migration-peachtree.acceptance.ts) proves the books;
 * this one proves the wire: the raw-body piece route, its limits, three
 * pieces in flight, a piece cut off mid-way and resumed, the background
 * reader in the API process, the batch showing its progress, and the API's
 * memory while it reads.
 *
 * Usage: build and boot the API isolated (workers other than the reader off,
 * Cloudinary and email off, --max-old-space-size=768), then
 *   PTB_SAMPLE=/path/to/company.ptb API_BASE=http://localhost:3000/api/v1 \
 *   DATABASE_URL=postgres://… [API_PID=<pid>] npm run test:migration-ptb-http
 * The backup is the owner's and never enters the repository.
 */
import { createHash } from 'crypto';
import { open, readFile } from 'fs/promises';
import { basename } from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { Client } = require('pg');

const API = process.env.API_BASE || 'http://localhost:3000/api/v1';
const DB = process.env.DATABASE_URL || '';
const SAMPLE = process.env.PTB_SAMPLE || '';
const API_PID = process.env.API_PID;
const RUN = Date.now().toString(36);
/** A Peachtree backup, or any other large export (then checked as an extract). */
const IS_PTB = /\.ptb$/i.test(SAMPLE);
const SOURCE =
  process.env.SAMPLE_SOURCE || (IS_PTB ? 'peachtree' : 'quickbooks_online');
const PASSWORD = 'Migrate#2026';

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
      `  ✗ ${name}${detail !== undefined ? ' :: ' + JSON.stringify(detail).slice(0, 600) : ''}`,
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
  p: string,
  body?: unknown,
  token?: string,
  extra: {
    raw?: Buffer;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {
    'Content-Type': extra.raw ? 'application/octet-stream' : 'application/json',
    ...extra.headers,
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${API}${p}`, {
    method,
    headers,
    body:
      (extra.raw ? new Uint8Array(extra.raw) : undefined) ??
      (body === undefined ? undefined : JSON.stringify(body)),
    signal: extra.signal,
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

/** Peak resident memory of the API process (VmHWM), MB. */
async function apiPeakMb(): Promise<number | null> {
  if (!API_PID) return null;
  const status = await readFile(`/proc/${API_PID}/status`, 'utf8').catch(
    () => '',
  );
  const m = /VmHWM:\s+(\d+) kB/.exec(status);
  return m ? Math.round(Number(m[1]) / 1024) : null;
}
async function apiRssMb(): Promise<number | null> {
  if (!API_PID) return null;
  const status = await readFile(`/proc/${API_PID}/status`, 'utf8').catch(
    () => '',
  );
  const m = /VmRSS:\s+(\d+) kB/.exec(status);
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

async function provision(pg: any) {
  const email = `ptbhttp${RUN}@finmatrix.pk`;
  const signup = await req('POST', '/auth/signup', {
    email,
    password: PASSWORD,
    displayName: 'Peachtree HTTP Owner',
    phone: '+92-300-1234567',
    role: 'admin',
  });
  if (!signup.data?.tokens?.accessToken)
    throw new Error(
      `signup failed: ${signup.status} ${JSON.stringify(signup.body)}`,
    );
  await pg.query(
    `UPDATE users SET is_email_verified = true, email_verified_at = COALESCE(email_verified_at, now()) WHERE id = $1`,
    [signup.data.user.id],
  );
  const first = signup.data.tokens.accessToken;
  const co = await req(
    'POST',
    '/companies',
    { name: `Peachtree HTTP ${RUN}`, industry: 'Retail' },
    first,
  );
  if (!co.data?.id)
    throw new Error(
      `company create failed: ${co.status} ${JSON.stringify(co.body)}`,
    );
  await req('POST', `/companies/${co.data.id}/submit`, {}, first);
  await pg.query(
    `UPDATE companies SET status = 'active', subscription_plan = 'standard', subscription_status = 'active',
            company_type = 'warehouse', inventory_enabled = true, fiscal_year_start_month = 6 WHERE id = $1`,
    [co.data.id],
  );
  const signin = await req('POST', '/auth/signin', {
    email,
    password: PASSWORD,
  });
  return {
    companyId: co.data.id as string,
    token: signin.data.tokens.accessToken as string,
  };
}

async function main() {
  if (!SAMPLE) {
    console.log(
      "PTB_SAMPLE is not set: skipped (the backup is the owner's and is not in the repository).",
    );
    return;
  }
  if (!DB) throw new Error('DATABASE_URL is required.');
  const pg = new Client({ connectionString: DB });
  await pg.connect();
  const t0 = Date.now();
  try {
    const { token } = await provision(pg);
    const b = await req(
      'POST',
      '/migrations',
      {
        sourceSystem: SOURCE,
        cutoverDate: process.env.SAMPLE_CUTOVER || '2026-10-06',
      },
      token,
    );
    const batchId = b.data.id as string;
    const name = basename(SAMPLE);
    const fh = await open(SAMPLE, 'r');
    const { size } = await fh.stat();
    const base = `/migrations/${batchId}/uploads`;

    console.log('\n── The routes and their limits');
    const viaSheets = await (async () => {
      const form = new FormData();
      form.append(
        'files',
        new Blob([Buffer.from('not really a backup')]),
        'company.ptb',
      );
      const r = await fetch(`${API}/migrations/${batchId}/files`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
      return {
        status: r.status,
        body: await r.json().catch(() => null),
      } as Res;
    })();
    ok(
      'a .ptb on the spreadsheet route: 415, pointing to the large upload',
      viaSheets.status === 415 &&
        codeOf(viaSheets) === 'MIGRATION_USE_LARGE_UPLOAD',
      viaSheets,
    );
    const tooBig = await req(
      'POST',
      base,
      { name, size: 3 * 1024 ** 3 },
      token,
    );
    ok(
      '3 GB is refused before anything is sent (413)',
      tooBig.status === 413 && codeOf(tooBig) === 'MIGRATION_FILE_TOO_LARGE',
      tooBig,
    );
    const noAuth = await req('POST', base, { name, size });
    ok('no token: 401', noAuth.status === 401, noAuth.status);

    const start = await req('POST', base, { name, size }, token);
    ok(
      'start: 8 MB pieces',
      start.status === 201 && start.data.partSize === 8 * 1024 * 1024,
      start,
    );
    const up = start.data as { id: string; parts: number; partSize: number };
    const piece = async (n: number) => {
      const len = Math.min(up.partSize, size - n * up.partSize);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, n * up.partSize);
      return buf;
    };
    const p0 = await piece(0);
    const oversize = await req(
      'PUT',
      `${base}/${up.id}/parts/0`,
      undefined,
      token,
      { raw: Buffer.concat([p0, Buffer.alloc(1)]) },
    );
    ok('a piece over 8 MB: 413', oversize.status === 413, oversize);
    const badHash = await req(
      'PUT',
      `${base}/${up.id}/parts/0`,
      undefined,
      token,
      { raw: p0, headers: { 'x-part-sha256': '0'.repeat(64) } },
    );
    ok(
      'a piece whose SHA-256 disagrees: refused',
      badHash.status === 400 &&
        codeOf(badHash) === 'MIGRATION_UPLOAD_PART_CORRUPT',
      badHash,
    );

    console.log('\n── The file, three pieces at a time, one lost on the way');
    // Piece 1 never arrives the first time, as when the connection drops
    // while it is on its way (deterministic: no race with a fast network).
    const tUp = Date.now();
    const queue = Array.from({ length: up.parts }, (_, n) => n).filter(
      (n) => n !== 1,
    );
    const sendOne = async (n: number) => {
      const data = await piece(n);
      const sha = createHash('sha256').update(data).digest('hex');
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await req(
          'PUT',
          `${base}/${up.id}/parts/${n}`,
          undefined,
          token,
          { raw: data, headers: { 'x-part-sha256': sha } },
        );
        if (r.status === 200 || r.status === 201) return;
        if (attempt === 3)
          throw new Error(`piece ${n}: ${r.status} ${JSON.stringify(r.body)}`);
      }
    };
    await Promise.all(
      [0, 1, 2].map(async () => {
        while (queue.length) await sendOne(queue.shift()!);
      }),
    );
    const early = await req(
      'POST',
      `${base}/${up.id}/complete`,
      undefined,
      token,
    );
    ok(
      'complete with the cut-off piece missing: refused, naming it',
      early.status === 400 &&
        codeOf(early) === 'MIGRATION_UPLOAD_INCOMPLETE' &&
        JSON.stringify(early.body).includes('"missing":[1]'),
      early.body,
    );
    const resumed = await req('POST', base, { name, size }, token);
    ok(
      'starting again resumes, holding all but that piece',
      resumed.data.id === up.id &&
        resumed.data.received.length === up.parts - 1 &&
        !resumed.data.received.includes(1),
      resumed.data.received?.length,
    );
    await sendOne(1);
    const done = await req(
      'POST',
      `${base}/${up.id}/complete`,
      undefined,
      token,
    );
    const upSecs = (Date.now() - tUp) / 1000;
    ok(
      'complete: queued to be read',
      done.status === 200 && done.data.status === 'received',
      done.body,
    );
    console.log(
      `     ${up.parts} pieces of ${(size / 1e6).toFixed(1)} MB in ${upSecs.toFixed(1)} s over localhost`,
    );
    await fh.close();

    console.log('\n── The API reads it in the background');
    const rssBefore = await apiRssMb();
    const tRead = Date.now();
    const stages = new Set<string>();
    let batch: any = null;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      batch = (await req('GET', `/migrations/${batchId}`, undefined, token))
        .data;
      const u = (batch.uploads ?? []).find((x: any) => x.id === up.id);
      if (u?.progress?.stage) stages.add(u.progress.stage);
      if (u && (u.status === 'read' || u.status === 'failed')) break;
      if (Date.now() - tRead > 10 * 60_000)
        throw new Error('reading took over 10 minutes');
    }
    const u = batch.uploads.find((x: any) => x.id === up.id);
    ok('read', u.status === 'read', u);
    console.log(
      `     read in ${((Date.now() - tRead) / 1000).toFixed(1)} s; stages seen: ${[...stages].join(' → ')}`,
    );
    ok(
      'the batch shows the file, with what it holds',
      (batch.files ?? []).some(
        (f: any) =>
          f.kind === (IS_PTB ? 'ptb' : 'extract') &&
          f.sizeBytes === size &&
          (f.detected ?? []).length >= (IS_PTB ? 5 : 3),
      ),
      batch.files?.map((f: any) => [f.kind, f.sizeBytes, f.detected?.length]),
    );
    const issues = (
      await req(
        'GET',
        `/migrations/${batchId}/issues?limit=100`,
        undefined,
        token,
      )
    ).data;
    const codes = new Set((issues.items ?? []).map((i: any) => i.code));
    if (IS_PTB)
      ok(
        "Peachtree's reports are asked for",
        codes.has('PEACHTREE_REPORTS_MISSING'),
        [...codes],
      );
    const [{ n }] = (
      await pg.query(
        `SELECT COUNT(*)::int AS n FROM migration_upload_parts WHERE upload_id = $1`,
        [up.id],
      )
    ).rows;
    ok('no piece is left in the database', n === 0, n);
    const peak = await apiPeakMb();
    if (peak !== null) {
      console.log(
        `     API memory: ${rssBefore} MB before reading, peak ${peak} MB over the whole run`,
      );
      ok(
        'the API stayed well inside the 1 GB task (peak under 700 MB)',
        peak < 700,
        peak,
      );
    }
  } finally {
    await pg.end();
  }
  console.log(
    `\n${pass} passed, ${fail} failed in ${((Date.now() - t0) / 1000).toFixed(1)} s`,
  );
  if (fail) {
    console.log('Failed:\n' + failures.map((f) => `  - ${f}`).join('\n'));
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
