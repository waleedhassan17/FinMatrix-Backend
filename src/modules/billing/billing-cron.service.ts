import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { BillingService } from './billing.service';

/**
 * phase2.md step 5 — runs the subscription expiry/reminder scan once a day.
 * The scan itself is idempotent (deduped per-day reminders, one-time
 * deactivation) so an extra run is harmless. Disabled via BILLING_CRON=off.
 */
@Injectable()
export class BillingCronService implements OnApplicationBootstrap {
  private readonly logger = new Logger(BillingCronService.name);
  private running = false;

  constructor(
    private readonly billing: BillingService,
    private readonly dataSource: DataSource,
  ) {}

  /**
   * Deploy-window heal (migrations run before the new API is live): the
   * previous release could still approve a company with no plan and no end
   * date while this one was rolling out. Name them once at boot so an admin
   * can give them plan terms ("Activate plan" in the console).
   */
  async onApplicationBootstrap() {
    try {
      const rows: Array<{ id: string; name: string }> =
        await this.dataSource.query(
          `SELECT id, name FROM companies
            WHERE status IN ('approved', 'active')
              AND coalesce(subscription_plan, 'free') = 'free'
              AND subscription_expiry_date IS NULL
              AND suspended_at IS NULL
              AND reviewed_at > now() - interval '2 days'
            LIMIT 50`,
        );
      if (rows.length) {
        this.logger.warn(
          `${rows.length} compan${rows.length === 1 ? 'y was' : 'ies were'} approved in the last 2 days ` +
            `with no plan and no end date (likely by the previous release during the deploy): ` +
            rows.map((r) => `${r.name} (${r.id})`).join(', ') +
            '. Give each a plan and an end date in the admin console.',
        );
      }
    } catch (err) {
      this.logger.debug(
        `approval heal check skipped: ${(err as Error).message}`,
      );
    }
  }

  @Cron(CronExpression.EVERY_DAY_AT_1AM, {
    name: 'subscription-expiry-scan',
    timeZone: 'Asia/Karachi',
  })
  async handleDailyScan() {
    if (process.env.BILLING_CRON === 'off') return;
    if (this.running) return; // never overlap
    this.running = true;
    try {
      await this.billing.runExpiryScan();
    } catch (err) {
      this.logger.error('Daily expiry scan failed', err as Error);
    } finally {
      this.running = false;
    }
  }
}
