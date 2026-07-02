import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { BillingService } from './billing.service';

/**
 * phase2.md step 5 — runs the subscription expiry/reminder scan once a day.
 * The scan itself is idempotent (deduped per-day reminders, one-time
 * deactivation) so an extra run is harmless. Disabled via BILLING_CRON=off.
 */
@Injectable()
export class BillingCronService {
  private readonly logger = new Logger(BillingCronService.name);
  private running = false;

  constructor(private readonly billing: BillingService) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM, { name: 'subscription-expiry-scan' })
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
