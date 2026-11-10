import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { IdempotencyRecord } from './idempotency-record.entity';

/**
 * How long a stored response can be replayed. Retries come within seconds or
 * minutes (a double-tap, a flaky connection); a week is generous, and keeps
 * the table from growing with every keyed POST forever.
 */
export const IDEMPOTENCY_RETENTION_DAYS = 7;

@Injectable()
export class IdempotencyCleanupService {
  private readonly logger = new Logger(IdempotencyCleanupService.name);
  private running = false;

  constructor(
    @InjectRepository(IdempotencyRecord)
    private readonly repo: Repository<IdempotencyRecord>,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { name: 'idempotency-cleanup' })
  async handleDailyCleanup(): Promise<void> {
    if (this.running) return; // never overlap
    this.running = true;
    try {
      const removed = await this.purgeExpired();
      if (removed > 0)
        this.logger.log(`removed ${removed} expired idempotency records`);
    } catch (err) {
      this.logger.error(
        `idempotency cleanup failed: ${(err as Error).message}`,
      );
    } finally {
      this.running = false;
    }
  }

  /** Delete records past retention. Exposed for tests. */
  async purgeExpired(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(
      now.getTime() - IDEMPOTENCY_RETENTION_DAYS * 86_400_000,
    );
    const res = await this.repo.delete({ createdAt: LessThan(cutoff) });
    return res.affected ?? 0;
  }
}
