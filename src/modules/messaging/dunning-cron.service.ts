import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { companyFeatures } from '../../common/features/company-features.util';
import { MessagingService, rowsOf } from './messaging.service';
import { MessagingSettingsService } from './messaging-settings.service';
import { messagingWorker } from './messaging-env.util';
import { reminderTargets, zonedToday } from './collections.util';
import { reminderMessage } from './document-messages';

/**
 * Payment reminders on WhatsApp. Hourly: for each company with Connect on,
 * every open invoice whose due date sits at a configured offset TODAY (company
 * time) gets one reminder per offset — docVersion is the offset, so the 24
 * hourly runs of a day queue it once. The dispatcher holds it until quiet
 * hours end and re-checks the invoice just before sending.
 *
 * Skipped: void, paid or zero-balance invoices, opted-out customers and
 * customers whose collections are paused. Runs only for a rule of 'auto'
 * (decision D24: an "ask each time" rule is the Send reminder button).
 */
@Injectable()
export class DunningCronService {
  private readonly logger = new Logger(DunningCronService.name);
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly settings: MessagingSettingsService,
    private readonly messaging: MessagingService,
  ) {}

  @Cron('0 * * * *', { name: 'messaging-dunning' })
  async hourly(): Promise<void> {
    if (!messagingWorker(this.config) || this.running) return;
    this.running = true;
    try {
      const n = await this.runOnce();
      if (n.queued > 0)
        this.logger.log(
          `reminders queued: ${n.queued} (checked ${n.invoices})`,
        );
    } catch (err) {
      this.logger.error(`dunning run failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass at `now`. Exposed for the acceptance test. */
  async runOnce(
    now: Date = new Date(),
    onlyCompanyId?: string,
  ): Promise<{ invoices: number; queued: number }> {
    const companies = rowsOf(
      await this.dataSource.query(
        `SELECT company_id FROM company_messaging_settings WHERE enabled = true
           ${onlyCompanyId ? 'AND company_id = $1' : ''}`,
        onlyCompanyId ? [onlyCompanyId] : [],
      ),
    ).map((r) => String(r.company_id));

    let invoices = 0;
    let queued = 0;
    for (const companyId of companies) {
      const features = await companyFeatures(
        this.dataSource.manager,
        companyId,
      );
      if (!features.whatsappConnect) continue;
      const s = await this.settings.resolve(companyId);
      const targets = reminderTargets(
        zonedToday(now, s.timezone),
        s.reminderSchedule,
      ).filter((t) => s.eventRules[t.event] === 'auto');
      if (targets.length === 0) continue;

      const rows = rowsOf(
        await this.dataSource.query(
          `SELECT i.id, i.company_id, i.customer_id, i.invoice_number, i.total, i.balance,
                  to_char(i.due_date, 'YYYY-MM-DD') AS due_date
             FROM invoices i
             JOIN customers c ON c.id = i.customer_id AND c.company_id = i.company_id
            WHERE i.company_id = $1
              AND i.status IN ('sent', 'partial')
              AND i.balance > 0
              AND i.due_date = ANY($2::date[])
              AND c.whatsapp_opt_out = false
              AND c.collections_paused = false`,
          [companyId, [...new Set(targets.map((t) => t.dueDate))]],
        ),
      );
      for (const r of rows) {
        const due = String(r.due_date);
        for (const t of targets.filter((x) => x.dueDate === due)) {
          invoices++;
          const res = await this.messaging.enqueue(
            null,
            reminderMessage(
              {
                id: String(r.id),
                companyId,
                customerId: String(r.customer_id),
                invoiceNumber: String(r.invoice_number),
                total: String(r.total),
                balance: String(r.balance),
                dueDate: due,
              },
              t,
            ),
          );
          if (res && !res.duplicate && res.status === 'queued') queued++;
        }
      }
    }
    return { invoices, queued };
  }
}
