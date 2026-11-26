import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression, Interval } from '@nestjs/schedule';
import { parseBoolean } from '../../common/utils/env.util';
import { AccountAdminService } from './account-admin.service';

/**
 * Drains company deletion jobs that were not started (or were interrupted),
 * and deletes final backups past their retention. Off with
 * ACCOUNT_DELETION_WORKER_ENABLED=false (tests that must not pick up another
 * process's work).
 */
@Injectable()
export class AccountAdminWorker {
  private readonly logger = new Logger(AccountAdminWorker.name);
  private running = false;

  constructor(private readonly accounts: AccountAdminService) {}

  private enabled() {
    return parseBoolean(process.env.ACCOUNT_DELETION_WORKER_ENABLED) ?? true;
  }

  @Interval('account-deletion-worker', 15_000)
  async tick() {
    if (!this.enabled() || this.running) return;
    this.running = true;
    try {
      while (await this.accounts.runNext()) {
        /* drain */
      }
    } catch (err) {
      this.logger.error(`deletion tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  @Cron(CronExpression.EVERY_HOUR, { name: 'final-backup-expiry' })
  async sweep() {
    if (!this.enabled()) return;
    try {
      const n = await this.accounts.sweepExpiredFinalBackups();
      if (n) this.logger.log(`Deleted ${n} expired final backup(s)`);
    } catch (err) {
      this.logger.error(`final backup sweep failed: ${(err as Error).message}`);
    }
  }
}
