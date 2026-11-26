import { reportFailure } from '../../../common/monitoring/report-failure';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { createHash } from 'crypto';
import { createWriteStream } from 'fs';
import { mkdtemp, rm, statfs } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource } from 'typeorm';

import { MigrationBatch } from '../entities/migration-batch.entity';
import {
  MigrationUpload,
  MigrationUploadProgress,
} from '../entities/migration-upload.entity';
import { MigrationBatchService } from '../migration-batch.service';
import { openingDateOf } from '../opening-date';
import { BtrieveError } from '../sources/peachtree/btrieve';
import {
  PEACHTREE_TABLES,
  readPeachtreeBooks,
} from '../sources/peachtree/peachtree-books';
import {
  extractTables,
  inspectArchive,
  PTB_ZIP_LIMITS,
} from '../sources/peachtree/zip';
import { readExport, SourceExtract } from './export-reader';
import { StorageService } from '../../../common/storage/storage.service';
import { ABANDONED_AFTER_HOURS } from './migration-uploads.service';
import { SYS, SYSTEM_ACCOUNT_DEFS } from '../../accounts/accounts.constants';

/** A read that has not finished in this long died with its process. */
const STUCK_AFTER_MINUTES = 30;
const MAX_ATTEMPTS = 3;
/** Free disk kept back beyond what a step writes. */
const DISK_HEADROOM = 256 * 1024 * 1024;

class ReadFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    /** True when another attempt cannot help (a damaged or unsupported backup). */
    readonly final: boolean,
  ) {
    super(message);
  }
}

/**
 * Reads uploaded Peachtree backups, one at a time, in the background: the
 * upload request returns at once and the owner watches the progress.
 *
 * Every 5 s (MIGRATION_READ_WORKER_ENABLED, default true) it claims ONE
 * `received` upload with FOR UPDATE SKIP LOCKED — the export worker's pattern —
 * so several API tasks never read the same backup. A read that dies with its
 * process is returned to `received` after STUCK_AFTER_MINUTES and retried, at
 * most MAX_ATTEMPTS times. A backup that is damaged or not a Peachtree company
 * fails at once with its reason; retrying cannot help.
 *
 * The backup is rebuilt on local disk from its pieces (hashed as it goes),
 * only the tables the import needs are unpacked (each checked against the
 * archive's CRC-32), and the pieces are deleted as soon as the read succeeds:
 * the original is not kept, only what was read from it.
 */
@Injectable()
export class MigrationReadWorker {
  private readonly logger = new Logger(MigrationReadWorker.name);
  private running = false;
  private readonly enabled: boolean;

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly batches: MigrationBatchService,
    config: ConfigService,
  ) {
    this.enabled =
      String(config.get('MIGRATION_READ_WORKER_ENABLED')) !== 'false';
  }

  @Interval('migration-read-worker', 5_000)
  async tick(): Promise<void> {
    if (!this.enabled || this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(`read worker pass failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass: recover, purge, claim one, read it. Exposed for tests. */
  async runOnce(): Promise<MigrationUpload | null> {
    await this.recoverStuck();
    await this.purgeAbandoned();
    const upload = await this.claim();
    if (upload) await this.read(upload);
    return upload;
  }

  private async recoverStuck() {
    // Died after the backup was recorded (only its analysis was left): finish
    // that, rather than read a backup whose pieces are already gone.
    const recorded: Array<{
      id: string;
      company_id: string;
      batch_id: string;
    }> = await this.dataSource.query(
      `SELECT id, company_id, batch_id FROM migration_uploads
          WHERE status = 'reading' AND file_id IS NOT NULL
            AND updated_at < now() - ($1 || ' minutes')::interval`,
      [String(STUCK_AFTER_MINUTES)],
    );
    for (const u of recorded) {
      await this.batches.finishBackupRead(u.company_id, u.batch_id, u.id);
    }
    await this.dataSource.query(
      `UPDATE migration_uploads
          SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'received' END,
              error_code = CASE WHEN attempts >= $2 THEN 'MIGRATION_PTB_UNREADABLE' ELSE error_code END,
              error = CASE WHEN attempts >= $2 THEN 'Reading the backup stopped repeatedly. Upload it again; if it happens again, contact support.' ELSE error END,
              updated_at = now()
        WHERE status = 'reading' AND file_id IS NULL
          AND updated_at < now() - ($1 || ' minutes')::interval`,
      [String(STUCK_AFTER_MINUTES), MAX_ATTEMPTS],
    );
  }

  /**
   * Uploads left unfinished, or failed, for a day: their pieces, then them.
   * Pieces are removed explicitly — the foreign key's cascade is a safety
   * net, not something a database built by synchronize has.
   */
  private async purgeAbandoned() {
    await this.dataSource.transaction(async (em) => {
      const rows: Array<{ id: string }> = await em.query(
        `SELECT id FROM migration_uploads
          WHERE status IN ('receiving', 'failed') AND updated_at < now() - ($1 || ' hours')::interval
          FOR UPDATE SKIP LOCKED`,
        [String(ABANDONED_AFTER_HOURS)],
      );
      if (!rows.length) return;
      const ids = rows.map((r) => r.id);
      await em.query(
        `DELETE FROM migration_upload_parts WHERE upload_id = ANY($1::uuid[])`,
        [ids],
      );
      await em.query(
        `DELETE FROM migration_uploads WHERE id = ANY($1::uuid[])`,
        [ids],
      );
    });
  }

  async claim(): Promise<MigrationUpload | null> {
    const raw = await this.dataSource.query(
      `UPDATE migration_uploads
          SET status = 'reading', started_at = now(), attempts = attempts + 1, updated_at = now()
        WHERE id = (
          SELECT id FROM migration_uploads
           WHERE status = 'received'
           ORDER BY received_at
           LIMIT 1
           FOR UPDATE SKIP LOCKED)
        RETURNING id`,
    );
    const rows = Array.isArray(raw?.[0]) ? raw[0] : raw;
    const id = rows?.[0]?.id as string | undefined;
    return id
      ? this.dataSource.manager.findOneOrFail(MigrationUpload, {
          where: { id },
        })
      : null;
  }

  private async progress(id: string, p: MigrationUploadProgress) {
    await this.dataSource.query(
      `UPDATE migration_uploads SET progress = $2, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(p)],
    );
  }

  private async assertDisk(dir: string, bytes: number): Promise<void> {
    const disk = await statfs(dir);
    if (disk.bavail * disk.bsize < bytes + DISK_HEADROOM) {
      throw new ReadFailure(
        'MIGRATION_SERVER_DISK_FULL',
        'The server has too little free disk to read this backup now. Try again later; if it persists, contact support.',
        false,
      );
    }
  }

  /** Read one claimed upload; never throws. */
  async read(upload: MigrationUpload): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), 'finmatrix-ptb-'));
    try {
      // Disk is checked for each step: the backup, then exactly the tables
      // it unpacks to (the archive declares their sizes, and the reader holds
      // it to them).
      await this.assertDisk(dir, upload.sizeBytes);
      const isBackup = /\.ptb$/i.test(upload.originalName);
      const file = join(dir, isBackup ? 'backup.ptb' : 'export');
      const sha256 = await this.assemble(upload, file);
      if (!isBackup) {
        await this.readOtherExport(upload, file, sha256);
        return;
      }
      await this.progress(upload.id, {
        stage: 'unpacking',
        done: 0,
        total: upload.sizeBytes,
      });
      let paths: Map<string, string>;
      try {
        const wanted = new Set<string>(PEACHTREE_TABLES);
        const archive = await inspectArchive(file, PTB_ZIP_LIMITS);
        const unpacked = archive.entries
          .filter(
            (e) => !/[\\/]/.test(e.name) && wanted.has(e.name.toUpperCase()),
          )
          .reduce((t, e) => t + e.uncompressedSize, 0);
        await this.assertDisk(dir, unpacked);
        paths = await extractTables(file, wanted, dir, PTB_ZIP_LIMITS);
      } catch (err) {
        if (err instanceof BtrieveError)
          throw new ReadFailure(err.code, err.message, true);
        throw err;
      }
      await rm(file, { force: true }); // the tables are out; free the disk
      const missing = PEACHTREE_TABLES.filter((t) => !paths.has(t));
      if (missing.length) {
        throw new ReadFailure(
          'MIGRATION_PTB_TABLE_MISSING',
          `This is not a complete Peachtree / Sage 50 company backup: ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing. In Peachtree use File → Back Up, and upload that file.`,
          true,
        );
      }
      const batch = await this.dataSource.manager.findOneOrFail(
        MigrationBatch,
        {
          where: { id: upload.batchId, companyId: upload.companyId },
        },
      );
      const chart: Array<{
        accountNumber: string;
        name: string;
        systemRole: string | null;
      }> = await this.dataSource.query(
        `SELECT account_number AS "accountNumber", name, system_role AS "systemRole" FROM accounts WHERE company_id = $1`,
        [upload.companyId],
      );
      // Where this company keeps customer credits now (its number may have moved).
      const advances =
        chart.find((a) => a.systemRole === SYS.CUSTOMER_ADVANCES)
          ?.accountNumber ??
        SYSTEM_ACCOUNT_DEFS.customer_advances.defaultNumber;
      let last = 0;
      let extract;
      try {
        extract = await readPeachtreeBooks(paths, {
          cutoverDate: batch.cutoverDate,
          openingDate: openingDateOf(batch.cutoverDate),
          existingAccounts: chart,
          numbers: { customerAdvances: advances },
          onProgress: (table, done) => {
            if (Date.now() - last < 2_000) return;
            last = Date.now();
            void this.progress(upload.id, {
              stage: 'reading',
              detail: table,
              done,
            });
          },
        });
      } catch (err) {
        // Anything the reader refuses is the backup's, not the server's.
        const code =
          err instanceof BtrieveError ? err.code : 'MIGRATION_PTB_UNREADABLE';
        throw new ReadFailure(
          code,
          `FinMatrix could not read this backup: ${(err as Error).message}`,
          true,
        );
      }
      await this.record(upload, sha256, extract, 'ptb');
    } catch (err) {
      const f =
        err instanceof ReadFailure
          ? err
          : new ReadFailure(
              'MIGRATION_PTB_UNREADABLE',
              (err as Error).message,
              false,
            );
      const retry = !f.final && upload.attempts < MAX_ATTEMPTS;
      if (!retry) {
        reportFailure({
          area: 'migration',
          id: upload.batchId,
          companyId: upload.companyId,
          code: f.code,
          error: f,
        });
      }
      this.logger.warn(
        `upload ${upload.id}: ${f.code} ${retry ? '(will retry)' : ''} ${f.message}`,
      );
      await this.dataSource.query(
        `UPDATE migration_uploads
            SET status = $2::varchar, error_code = $3, error = $4, finished_at = CASE WHEN $2::varchar = 'failed' THEN now() ELSE NULL END, updated_at = now()
          WHERE id = $1 AND status = 'reading'`,
        [
          upload.id,
          retry ? 'received' : 'failed',
          f.code,
          f.message.slice(0, 2000),
        ],
      );
      if (f.final) {
        await this.dataSource.query(
          `DELETE FROM migration_upload_parts WHERE upload_id = $1`,
          [upload.id],
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Any other large export (a ZIP of reports, a big CSV, workbook, IIF or
   * XML): read once, keeping only the sheets a migration uses.
   */
  private async readOtherExport(
    upload: MigrationUpload,
    file: string,
    sha256: string,
  ): Promise<void> {
    const batch = await this.dataSource.manager.findOneOrFail(MigrationBatch, {
      where: { id: upload.batchId, companyId: upload.companyId },
    });
    await this.progress(upload.id, {
      stage: 'reading',
      detail: upload.originalName,
    });
    let last = 0;
    let extract: SourceExtract;
    try {
      extract = await readExport(file, upload.originalName, {
        maxRows: 100_000,
        inMemoryBytes: 25 * 1024 * 1024,
        maxXmlBytes: 100 * 1024 * 1024,
        preferredSource: batch.sourceSystem,
        onProgress: (detail) => {
          if (Date.now() - last < 2_000) return;
          last = Date.now();
          void this.progress(upload.id, { stage: 'reading', detail });
        },
      });
    } catch (err) {
      throw new ReadFailure(
        'MIGRATION_FILE_UNREADABLE',
        `FinMatrix could not read ${upload.originalName}: ${(err as Error).message}`,
        true,
      );
    }
    await rm(file, { force: true });
    await this.record(upload, sha256, extract, 'extract');
  }

  /** Store what was read, record it as the batch's file, and analyse. */
  private async record(
    upload: MigrationUpload,
    sha256: string,
    extract: unknown,
    kind: 'ptb' | 'extract',
  ) {
    await this.progress(upload.id, { stage: 'analysing' });
    const put = await this.storage.putBuffer({
      bucket: 'migration-files',
      buffer: Buffer.from(JSON.stringify(extract)),
      mimeType: 'application/json',
      originalName: `${upload.originalName}.json`,
      publicPath: `/migrations/${upload.batchId}/files/${upload.id}`,
    });
    try {
      await this.batches.addReadBackup({
        companyId: upload.companyId,
        userId: upload.createdBy,
        batchId: upload.batchId,
        uploadId: upload.id,
        name: upload.originalName,
        size: upload.sizeBytes,
        sha256,
        storageKey: put.key,
        kind,
      });
    } catch (err) {
      await this.storage.remove(put.key).catch(() => undefined);
      const body = (err as { response?: { code?: string; message?: string } })
        .response;
      throw new ReadFailure(
        body?.code ?? 'MIGRATION_INVALID_TRANSITION',
        body?.message ?? (err as Error).message,
        true,
      );
    }
  }

  /** Write the pieces to `file` in order, one at a time; returns the SHA-256. */
  private async assemble(
    upload: MigrationUpload,
    file: string,
  ): Promise<string> {
    const hash = createHash('sha256');
    const out = createWriteStream(file);
    const parts = Math.max(1, Math.ceil(upload.sizeBytes / upload.partSize));
    let written = 0;
    let lastReport = 0;
    try {
      for (let n = 0; n < parts; n++) {
        const [row] = await this.dataSource.query(
          `SELECT data FROM migration_upload_parts WHERE upload_id = $1 AND part_no = $2`,
          [upload.id, n],
        );
        if (!row) {
          throw new ReadFailure(
            'MIGRATION_UPLOAD_INCOMPLETE',
            `Piece ${n} of the upload is missing. Upload the backup again.`,
            true,
          );
        }
        const data: Buffer = row.data;
        hash.update(data);
        written += data.length;
        if (!out.write(data))
          await new Promise<void>((r) => out.once('drain', () => r()));
        if (Date.now() - lastReport > 2_000) {
          lastReport = Date.now();
          await this.progress(upload.id, {
            stage: 'assembling',
            done: written,
            total: upload.sizeBytes,
          });
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) =>
        out.end((err?: Error | null) => (err ? reject(err) : resolve())),
      );
    }
    if (written !== upload.sizeBytes) {
      throw new ReadFailure(
        'MIGRATION_UPLOAD_INCOMPLETE',
        `The upload holds ${written} bytes; the backup has ${upload.sizeBytes}. Upload it again.`,
        true,
      );
    }
    return hash.digest('hex');
  }
}
