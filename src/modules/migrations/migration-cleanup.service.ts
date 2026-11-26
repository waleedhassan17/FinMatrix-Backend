import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { OperationalAuditService } from '../../common/audit/operational-audit.service';
import { StorageService } from '../../common/storage/storage.service';
import { parseBoolean } from '../../common/utils/env.util';
import { migrationDraftRetentionDays } from '../../config/launch.settings';
import { EDITABLE_STATUSES } from './state-machine';

/** Batch-scoped tables, children before the batch row. */
const BATCH_TABLES = [
  'migration_staging_rows',
  'migration_issues',
  'migration_mappings',
  'migration_batch_records',
  'migration_files',
  'migration_uploads', // its parts cascade
] as const;

/**
 * Daily housekeeping for the Migration Center (03:00 PKT):
 *
 *   - a batch nobody has touched for MIGRATION_DRAFT_RETENTION_DAYS (default
 *     30) while still editable — never imported — is deleted with its files,
 *     staging rows, issues and mappings: the owner walked away from it;
 *   - a CLOSED batch's staging rows are deleted: the import is final (closed
 *     batches cannot be undone) and the certificate and the books hold
 *     everything that matters.
 *
 * Committed, closed and rolled-back batches themselves are history and are
 * kept. Abandoned large uploads are already swept by the read worker.
 * Off with MIGRATION_CLEANUP_ENABLED=false.
 */
@Injectable()
export class MigrationCleanupService {
  private readonly logger = new Logger(MigrationCleanupService.name);
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly audit: OperationalAuditService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, {
    name: 'migration-cleanup',
    timeZone: 'Asia/Karachi',
  })
  async nightly() {
    if ((parseBoolean(process.env.MIGRATION_CLEANUP_ENABLED) ?? true) === false)
      return;
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.run();
      if (r.abandonedBatches || r.stagingRowsCleared) {
        this.logger.log(
          `Migration cleanup: ${r.abandonedBatches} abandoned batch(es), ` +
            `${r.stagingRowsCleared} staging row(s) of closed batches`,
        );
      }
    } catch (err) {
      this.logger.error(`Migration cleanup failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async run(now: Date = new Date()) {
    const cutoff = new Date(
      now.getTime() - migrationDraftRetentionDays() * 86_400_000,
    );
    const stale: Array<{ id: string; company_id: string }> =
      await this.dataSource.query(
        `SELECT id, company_id FROM migration_batches
          WHERE status = ANY($1) AND updated_at < $2
          ORDER BY updated_at LIMIT 200`,
        [EDITABLE_STATUSES, cutoff],
      );
    let abandoned = 0;
    for (const b of stale) {
      const keys = await this.dataSource.transaction(async (em) => {
        // Skip a batch someone is working on right now.
        const locked = await em.query(
          `SELECT id FROM migration_batches
            WHERE id = $1 AND status = ANY($2) AND updated_at < $3
            FOR UPDATE SKIP LOCKED`,
          [b.id, EDITABLE_STATUSES, cutoff],
        );
        if (!locked.length) return null;
        const files: Array<{ k: string }> = await em.query(
          `SELECT storage_key AS k FROM migration_files
            WHERE batch_id = $1 AND storage_key IS NOT NULL`,
          [b.id],
        );
        for (const t of BATCH_TABLES) {
          await em.query(`DELETE FROM "${t}" WHERE batch_id = $1`, [b.id]);
        }
        await em.query(`DELETE FROM migration_batches WHERE id = $1`, [b.id]);
        return files.map((f) => f.k);
      });
      if (keys === null) continue;
      for (const k of keys) await this.storage.remove(k);
      abandoned += 1;
      await this.audit.record({
        companyId: b.company_id,
        actorUserId: null,
        action: 'migration_batch_expired',
        targetType: 'migration_batch',
        targetId: b.id,
        details: {
          files: keys.length,
          retentionDays: migrationDraftRetentionDays(),
        },
      });
    }

    const cleared = await this.dataSource.query(
      `DELETE FROM migration_staging_rows s
        USING migration_batches b
        WHERE s.batch_id = b.id AND b.status = 'closed'`,
    );
    const stagingRowsCleared = Array.isArray(cleared)
      ? Number(cleared[1] ?? 0)
      : 0;
    return { abandonedBatches: abandoned, stagingRowsCleared };
  }
}
