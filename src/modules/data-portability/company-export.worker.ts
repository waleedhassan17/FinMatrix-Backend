import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { OperationalAuditService } from '../../common/audit/operational-audit.service';
import { StorageService } from '../../common/storage/storage.service';
import { envFlag } from '../../common/utils/env.util';
import { NotificationsService } from '../notifications/notifications.service';
import { CompanyExport } from './entities/company-export.entity';
import { CompanyExportBuilder } from './exporter/company-export.builder';

/** A `running` row older than this is treated as a crashed worker. */
const STUCK_RUNNING_MINUTES = 45;
const MAX_ATTEMPTS = 2;

export const EXPORT_STORAGE_BUCKET = 'exports';

/**
 * Builds queued company backups, one at a time per process.
 *
 * Every 5 s (when EXPORT_WORKER_ENABLED, default true) it claims ONE `queued`
 * row with FOR UPDATE SKIP LOCKED — the pattern the messaging dispatcher
 * uses, safe with several tasks running — and builds it outside any
 * transaction. The row is the job: status, attempts, error and the outcome
 * all live on it, so the owner's list is also the job log.
 *
 * One at a time because a backup is the heaviest thing this process does
 * (every table, PDFs, photos) and the task has 1 GB; two in parallel would
 * double the peak for no one's benefit. The hourly sweep deletes files past
 * their retention and marks the rows expired.
 */
@Injectable()
export class CompanyExportWorker {
  private readonly logger = new Logger(CompanyExportWorker.name);
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly builder: CompanyExportBuilder,
    private readonly storage: StorageService,
    private readonly notifications: NotificationsService,
    private readonly audit: OperationalAuditService,
  ) {}

  @Interval('company-export-worker', 5_000)
  async tick(): Promise<void> {
    if (!envFlag(this.config, 'EXPORT_WORKER_ENABLED', true) || this.running)
      return;
    this.running = true;
    try {
      // Drain the queue rather than one per tick: a tick that finds work keeps
      // going until the queue is empty, so a burst does not wait 5 s each.
      while ((await this.runOnce()) !== 'idle') {
        /* keep draining */
      }
    } catch (err) {
      this.logger.error(`export tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass: return stuck rows, claim one, build it. Exposed for tests. */
  async runOnce(): Promise<'idle' | 'ready' | 'failed'> {
    await this.returnStuck();
    const job = await this.claim();
    if (!job) return 'idle';
    return this.process(job);
  }

  async returnStuck(): Promise<void> {
    const requeued = rowsOf(
      await this.dataSource.query(
        `UPDATE company_exports
            SET status = 'queued', updated_at = now()
          WHERE status = 'running'
            AND started_at < now() - ($1 || ' minutes')::interval
            AND attempts < $2
          RETURNING id`,
        [String(STUCK_RUNNING_MINUTES), MAX_ATTEMPTS],
      ),
    );
    if (requeued.length)
      this.logger.warn(`${requeued.length} stuck export(s) returned to queue`);
    await this.dataSource.query(
      `UPDATE company_exports
          SET status = 'failed', error = 'The backup took too long and was stopped. Please try again.',
              completed_at = now(), updated_at = now()
        WHERE status = 'running'
          AND started_at < now() - ($1 || ' minutes')::interval
          AND attempts >= $2`,
      [String(STUCK_RUNNING_MINUTES), MAX_ATTEMPTS],
    );
  }

  async claim(): Promise<CompanyExport | null> {
    const rows = rowsOf(
      await this.dataSource.query(
        `UPDATE company_exports
            SET status = 'running', started_at = now(), attempts = attempts + 1,
                error = NULL, updated_at = now()
          WHERE id = (
            SELECT id FROM company_exports
             WHERE status = 'queued'
             ORDER BY created_at
             LIMIT 1
             FOR UPDATE SKIP LOCKED)
          RETURNING id`,
      ),
    );
    if (rows.length === 0) return null;
    return this.dataSource.manager.findOne(CompanyExport, {
      where: { id: String(rows[0].id) },
    });
  }

  async process(job: CompanyExport): Promise<'ready' | 'failed'> {
    const startedAt = Date.now();
    const sink = await this.storage.putStream({
      bucket: EXPORT_STORAGE_BUCKET,
      name: `${job.companyId}/${job.id}.zip`,
      mimeType: 'application/zip',
    });
    try {
      const result = await this.builder.build({
        manager: this.dataSource.manager,
        companyId: job.companyId,
        exportId: job.id,
        asOf: job.asOf,
        includeXlsx: job.includeXlsx,
        requestedBy: job.requestedBy,
        sink: sink.stream,
      });
      const { size } = await sink.done;
      const expiresAt = new Date(
        Date.now() + this.retentionHours() * 3_600_000,
      );
      await this.dataSource.manager.update(
        CompanyExport,
        { id: job.id },
        {
          status: 'ready',
          storageKey: sink.key,
          sizeBytes: String(size),
          completedAt: new Date(),
          expiresAt,
          error: null,
          summary: {
            entities: Object.fromEntries(
              Object.entries(result.entities).map(([k, v]) => [k, v.rows]),
            ),
            attachments: result.attachments.included,
            reports: result.reports,
            durationMs: Date.now() - startedAt,
            peakRssMb: Math.round(result.peakRssBytes / 1_048_576),
          } as CompanyExport['summary'],
        },
      );
      this.logger.log(
        `export ${job.id} ready: ${size} bytes in ${Date.now() - startedAt} ms (peak rss ${Math.round(result.peakRssBytes / 1_048_576)} MB)`,
      );
      await this.audit.record({
        companyId: job.companyId,
        actorUserId: null,
        action: 'export_ready',
        targetType: 'company_export',
        targetId: job.id,
        details: { sizeBytes: size, durationMs: Date.now() - startedAt },
      });
      await this.notifications.create({
        companyId: job.companyId,
        userId: job.requestedBy,
        type: 'export_ready',
        title: 'Your company backup is ready',
        message: `${job.fileName} is ready to download. The link works until ${expiresAt.toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
        data: { exportId: job.id },
      });
      return 'ready';
    } catch (err) {
      const message = (err as Error).message ?? 'Unknown error';
      this.logger.error(`export ${job.id} failed: ${message}`);
      await sink.abort().catch(() => undefined);
      await this.dataSource.manager.update(
        CompanyExport,
        { id: job.id },
        {
          status: 'failed',
          error: message.slice(0, 1000),
          completedAt: new Date(),
          storageKey: null,
        },
      );
      await this.audit.record({
        companyId: job.companyId,
        actorUserId: null,
        action: 'export_failed',
        targetType: 'company_export',
        targetId: job.id,
        details: { error: message.slice(0, 500) },
      });
      await this.notifications.create({
        companyId: job.companyId,
        userId: job.requestedBy,
        type: 'export_failed',
        title: 'Your company backup could not be built',
        message:
          'Something went wrong while building the backup. Please try again; if it keeps failing, contact support with the time it happened.',
        data: { exportId: job.id },
      });
      return 'failed';
    }
  }

  /** Delete files past their retention and mark the rows expired. */
  @Cron(CronExpression.EVERY_HOUR, { name: 'company-export-expiry' })
  async expire(): Promise<number> {
    if (!envFlag(this.config, 'EXPORT_WORKER_ENABLED', true)) return 0;
    const due = await this.dataSource.manager
      .createQueryBuilder(CompanyExport, 'e')
      .where("e.status = 'ready' AND e.expiresAt < now()")
      .getMany();
    for (const row of due) {
      if (row.storageKey) await this.storage.remove(row.storageKey);
      await this.dataSource.manager.update(
        CompanyExport,
        { id: row.id },
        { status: 'expired', storageKey: null },
      );
    }
    if (due.length) this.logger.log(`${due.length} export(s) expired`);
    return due.length;
  }

  private retentionHours(): number {
    const raw = this.config.get<string | number>('EXPORT_RETENTION_HOURS', 24);
    const n = Number(raw);
    return Number.isFinite(n) && n >= 1 ? n : 24;
  }
}

/** TypeORM returns `[rows, count]` for UPDATE … RETURNING and `rows` for SELECT. */
function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(res)) return [];
  if (res.length === 2 && Array.isArray(res[0]) && typeof res[1] === 'number')
    return res[0] as Array<Record<string, unknown>>;
  if (res.length > 0 && Array.isArray(res[0]))
    return res[0] as Array<Record<string, unknown>>;
  return res as Array<Record<string, unknown>>;
}
