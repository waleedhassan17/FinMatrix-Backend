/**
 * Migration Center — large uploads (.ptb) and the background reader, the ways
 * they go wrong. In process, against the dev database; no real backup needed.
 *
 *   npx ts-node -r tsconfig-paths/register test/migration-uploads.acceptance.ts
 */
import './migration-harness.env';
import AdmZip from 'adm-zip';
import { createHash } from 'crypto';
import { asUpload, bootHarness, freshCompany } from './migration-harness';
import {
  MigrationUploadsService,
  UPLOAD_PART_BYTES,
} from '../src/modules/migrations/uploads/migration-uploads.service';
import { MigrationReadWorker } from '../src/modules/migrations/uploads/migration-read.worker';

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
const codeOf = async (p: Promise<unknown>): Promise<string | null> => {
  try {
    await p;
    return null;
  } catch (e: any) {
    return e?.response?.code ?? e?.code ?? String(e?.message ?? e);
  }
};

async function main() {
  const h = await bootHarness();
  const uploads = h.app.get(MigrationUploadsService);
  const worker = h.app.get(MigrationReadWorker);
  const t0 = Date.now();
  try {
    const { companyId, user } = await freshCompany(
      h.ds,
      `uploads-${Date.now()}`,
    );
    const newBatch = () =>
      h.svc.create(companyId, user, {
        sourceSystem: 'peachtree',
        cutoverDate: '2026-10-06',
      });
    /** Upload `data` as `name` in pieces and mark it complete. */
    const send = async (batchId: string, name: string, data: Buffer) => {
      const u = await uploads.start(companyId, user, batchId, {
        name,
        size: data.length,
      });
      for (let n = 0; n < u.parts; n++) {
        const piece = data.subarray(n * u.partSize, (n + 1) * u.partSize);
        await uploads.putPart(
          companyId,
          batchId,
          u.id,
          n,
          piece,
          createHash('sha256').update(piece).digest('hex'),
        );
      }
      await uploads.complete(companyId, batchId, u.id);
      return u;
    };
    /** Read whatever is queued, then the upload's state. */
    const readNow = async (batchId: string, id: string) => {
      await worker.runOnce();
      return uploads.status(companyId, batchId, id);
    };
    const partsOf = async (id: string) =>
      Number(
        (
          await h.ds.query(
            `SELECT COUNT(*)::int AS n FROM migration_upload_parts WHERE upload_id = $1`,
            [id],
          )
        )[0].n,
      );

    console.log('\n── Starting an upload');
    const b1 = await newBatch();
    ok(
      'only a backup or an export goes this way (not, say, a photo)',
      (await codeOf(
        uploads.start(companyId, user, b1.id, { name: 'scan.jpg', size: 10 }),
      )) === 'MIGRATION_FILE_UNREADABLE',
    );
    ok(
      'a size is required',
      (await codeOf(
        uploads.start(companyId, user, b1.id, { name: 'a.ptb', size: 0 }),
      )) === 'VALIDATION_FAILED',
    );
    ok(
      'over the limit (2 GB) is refused before anything is sent',
      (await codeOf(
        uploads.start(companyId, user, b1.id, {
          name: 'a.ptb',
          size: uploads.maxBytes + 1,
        }),
      )) === 'MIGRATION_FILE_TOO_LARGE',
    );
    ok(
      'a .ptb on the spreadsheet route is pointed to the large upload',
      (await codeOf(
        h.svc.addFiles(companyId, user, b1.id, [
          asUpload(Buffer.from('x'), 'company.ptb'),
        ]),
      )) === 'MIGRATION_USE_LARGE_UPLOAD',
    );

    console.log('\n── Pieces');
    const size = UPLOAD_PART_BYTES * 2 + 100;
    const u = await uploads.start(companyId, user, b1.id, {
      name: 'company.ptb',
      size,
    });
    ok('a 16 MB + 100 B file is three pieces', u.parts === 3);
    ok(
      'another file while one is uploading is refused',
      (await codeOf(
        uploads.start(companyId, user, b1.id, { name: 'other.ptb', size: 5 }),
      )) === 'MIGRATION_INVALID_TRANSITION',
    );
    ok(
      'a piece number outside the file is refused',
      (await codeOf(
        uploads.putPart(companyId, b1.id, u.id, 3, Buffer.alloc(100)),
      )) === 'MIGRATION_UPLOAD_INCOMPLETE',
    );
    ok(
      'a last piece of the wrong size is refused',
      (await codeOf(
        uploads.putPart(companyId, b1.id, u.id, 2, Buffer.alloc(99)),
      )) === 'MIGRATION_UPLOAD_PART_CORRUPT',
    );
    const last = Buffer.alloc(100, 1);
    ok(
      'a piece whose SHA-256 disagrees is refused',
      (await codeOf(
        uploads.putPart(companyId, b1.id, u.id, 2, last, '0'.repeat(64)),
      )) === 'MIGRATION_UPLOAD_PART_CORRUPT',
    );
    await uploads.putPart(companyId, b1.id, u.id, 2, last);
    const early = await codeOf(uploads.complete(companyId, b1.id, u.id));
    ok(
      'complete with pieces missing is refused',
      early === 'MIGRATION_UPLOAD_INCOMPLETE',
      early,
    );
    const resumed = await uploads.start(companyId, user, b1.id, {
      name: 'company.ptb',
      size,
    });
    ok(
      'starting again resumes, listing the pieces already held',
      resumed.id === u.id && JSON.stringify(resumed.received) === '[2]',
      resumed.received,
    );
    await uploads.cancel(companyId, b1.id, u.id);
    ok(
      'cancel removes the upload and its pieces',
      (await partsOf(u.id)) === 0 &&
        (await codeOf(uploads.status(companyId, b1.id, u.id))) !== null,
    );

    console.log(
      '\n── The background reader refuses what is not a Peachtree backup',
    );
    const junk = await send(b1.id, 'renamed.ptb', Buffer.alloc(3000, 0x41));
    const j = await readNow(b1.id, junk.id);
    ok(
      'a file renamed .ptb fails as unreadable, at once',
      j.status === 'failed' && j.errorCode === 'MIGRATION_PTB_UNREADABLE',
      j,
    );
    ok('its pieces are deleted', (await partsOf(junk.id)) === 0);
    const zip = new AdmZip();
    zip.addFile('CHART.DAT', Buffer.from('FC'));
    zip.addFile('notes.txt', Buffer.from('hello'));
    const partial = await send(b1.id, 'partial.ptb', zip.toBuffer());
    const p = await readNow(b1.id, partial.id);
    ok(
      'a ZIP without the company tables fails, naming them',
      p.status === 'failed' &&
        p.errorCode === 'MIGRATION_PTB_TABLE_MISSING' &&
        /JRNLROW\.DAT/.test(p.error ?? ''),
      p,
    );
    const batch = await h.svc.get(companyId, b1.id);
    ok(
      'nothing was added to the migration',
      (batch.files ?? []).length === 0,
      batch.files,
    );

    console.log('\n── A read that died with its process');
    const stuck = await send(b1.id, 'stuck.ptb', Buffer.alloc(500, 0x42));
    await h.ds.query(
      `UPDATE migration_uploads SET status = 'reading', attempts = 1, updated_at = now() - interval '31 minutes' WHERE id = $1`,
      [stuck.id],
    );
    const s = await readNow(b1.id, stuck.id);
    ok(
      'is picked up again and read (here: fails as unreadable)',
      s.status === 'failed' && s.errorCode === 'MIGRATION_PTB_UNREADABLE',
      s,
    );
    const [{ attempts }] = await h.ds.query(
      `SELECT attempts FROM migration_uploads WHERE id = $1`,
      [stuck.id],
    );
    ok('counting the attempt', Number(attempts) === 2, attempts);
    const dead = await send(b1.id, 'dead.ptb', Buffer.alloc(500, 0x43));
    await h.ds.query(
      `UPDATE migration_uploads SET status = 'reading', attempts = 3, updated_at = now() - interval '31 minutes' WHERE id = $1`,
      [dead.id],
    );
    const d = await readNow(b1.id, dead.id);
    ok(
      'after three attempts it is failed, not retried',
      d.status === 'failed' && /repeatedly/.test(d.error ?? ''),
      d,
    );
    // Died after the backup was recorded, during its analysis: the pieces
    // are gone, so it must be finished, not read again.
    const late = await send(b1.id, 'late.ptb', Buffer.alloc(300, 0x45));
    await h.ds.query(
      `UPDATE migration_uploads SET status = 'reading', attempts = 1, file_id = gen_random_uuid(), progress = '{"stage":"analysing"}', updated_at = now() - interval '31 minutes' WHERE id = $1`,
      [late.id],
    );
    await h.ds.query(
      `DELETE FROM migration_upload_parts WHERE upload_id = $1`,
      [late.id],
    );
    const l = await readNow(b1.id, late.id);
    ok(
      'one that died during its analysis is finished, not read again',
      l.status === 'read' &&
        l.errorCode === null &&
        l.progress?.stage === 'done',
      l,
    );

    console.log('\n── Abandoned uploads');
    const gone = await uploads.start(companyId, user, b1.id, {
      name: 'gone.ptb',
      size: 10,
    });
    await uploads.putPart(companyId, b1.id, gone.id, 0, Buffer.alloc(10));
    await h.ds.query(
      `UPDATE migration_uploads SET updated_at = now() - interval '25 hours' WHERE id = $1`,
      [gone.id],
    );
    await worker.runOnce();
    ok(
      'an upload left unfinished for a day is removed with its pieces',
      (await codeOf(uploads.status(companyId, b1.id, gone.id))) !== null &&
        (await partsOf(gone.id)) === 0,
    );

    console.log('\n── Only one reader claims an upload');
    const one = await send(b1.id, 'race.ptb', Buffer.alloc(200, 0x44));
    const claims = await Promise.all([
      worker.claim(),
      worker.claim(),
      worker.claim(),
    ]);
    const got = claims.filter((c) => c?.id === one.id).length;
    ok(
      'three readers at once: exactly one claims it',
      got === 1,
      claims.map((c) => c?.id ?? null),
    );
    await h.ds.query(`DELETE FROM migration_uploads WHERE id = $1`, [one.id]);
  } finally {
    await h.close();
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
