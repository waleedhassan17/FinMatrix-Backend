import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { parseBoolean } from '../../common/utils/env.util';
import { DemoRequestsService } from './demo-requests.service';

/** Every 5 minutes: the 2-hours-before reminder for scheduled demos. */
@Injectable()
export class DemoReminderWorker {
  private readonly logger = new Logger(DemoReminderWorker.name);
  private running = false;

  constructor(private readonly demos: DemoRequestsService) {}

  @Interval('demo-reminder-worker', 5 * 60_000)
  async tick() {
    if ((parseBoolean(process.env.DEMO_WORKER_ENABLED) ?? true) === false)
      return;
    if (this.running) return;
    this.running = true;
    try {
      const n = await this.demos.sendDueReminders();
      if (n) this.logger.log(`Sent ${n} demo reminder(s)`);
    } catch (err) {
      this.logger.error(`demo reminders failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
