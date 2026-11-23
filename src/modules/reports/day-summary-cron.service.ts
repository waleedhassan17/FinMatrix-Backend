import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { businessTimezone } from '../../common/utils/business-date.util';
import { effectiveCompanyStatus } from '../../common/utils/company-status.util';
import { envFlag } from '../../common/utils/env.util';
import { MailService } from '../mail/mail.service';
import { DaySummaryEmailInput } from '../mail/mail.templates';
import { NotificationsService } from '../notifications/notifications.service';
import { DaySummaryService } from './day-summary.service';
import { DayKpi, DaySummaryResponse } from './day-summary.types';
import { digestDayDue, digestMoney, longDayLabel } from './day-summary.util';

/** The in-app notification type the clients deep-link to the day from. */
export const DAY_SUMMARY_NOTIFICATION = 'day_summary';

/** TypeORM answers an UPDATE … RETURNING with [rows, count], a SELECT with rows. */
function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(res)) return [];
  if (res.length === 2 && Array.isArray(res[0]) && typeof res[1] === 'number') {
    return res[0] as Array<Record<string, unknown>>;
  }
  return res as Array<Record<string, unknown>>;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** "+8% vs yesterday", "new vs yesterday", or '' when there is nothing to say. */
function change(k: DayKpi): string {
  const prev = k.previousDay.total;
  if (prev === 0 && k.total === 0) return '';
  if (prev === 0) return 'up from nothing yesterday';
  const pct = Math.round(((k.total - prev) / Math.abs(prev)) * 100);
  if (pct === 0) return 'same as yesterday';
  return `${pct > 0 ? '+' : ''}${pct}% vs yesterday`;
}

/** The digest's headline rows, customers and warnings, formatted. */
export function digestContent(
  s: DaySummaryResponse,
  companyName: string,
  link: string,
): DaySummaryEmailInput {
  const money = (n: number) => digestMoney(s.currency, n);
  const note = (...parts: string[]) => parts.filter(Boolean).join(' · ');
  const h = s.headline;
  const rows: DaySummaryEmailInput['rows'] = [
    {
      label: 'Sales',
      value: money(h.sales.total),
      note: note(plural(h.sales.count, 'invoice'), change(h.sales)),
    },
    {
      label: 'Money received',
      value: money(h.received.total),
      note: note(plural(h.received.count, 'receipt'), change(h.received)),
    },
  ];
  if (h.orders) {
    rows.push({
      label: 'Orders booked',
      value: money(h.orders.total),
      note: note(plural(h.orders.count, 'sales order'), change(h.orders)),
    });
  }
  if (h.purchaseOrders) {
    rows.push({
      label: 'Purchase orders',
      value: money(h.purchaseOrders.total),
      note: note(`${h.purchaseOrders.count} placed`, change(h.purchaseOrders)),
    });
  }
  if (h.goodsReceived && h.goodsReceived.count > 0) {
    rows.push({
      label: 'Goods received',
      value: money(h.goodsReceived.total),
      note: `at cost, on ${plural(h.goodsReceived.count, 'purchase order')}`,
    });
  }
  rows.push({
    label: 'Purchases',
    value: money(h.purchases.total),
    note: plural(h.purchases.count, 'bill'),
  });
  if (s.sales.unpaid > 0) {
    rows.push({
      label: 'Still unpaid from these sales',
      value: money(s.sales.unpaid),
    });
  }
  if (s.profit) {
    rows.push({ label: 'Gross profit', value: money(s.profit.grossProfit) });
  }

  const a = s.attention;
  const attention: string[] = [];
  if (a.backdated > 0) {
    attention.push(
      `${plural(a.backdated, 'entry', 'entries')} made today but dated earlier`,
    );
  }
  if (a.drafts > 0) {
    attention.push(`${plural(a.drafts, 'draft')} not yet posted`);
  }
  if (a.voided && a.voided.count > 0) {
    attention.push(
      `${plural(a.voided.count, 'document')} voided or deleted (${money(a.voided.total)})`,
    );
  }
  if (a.cancelledOrders > 0) {
    attention.push(
      s.purchasing
        ? `${plural(a.cancelledOrders, 'order')} cancelled or withdrawn`
        : `${plural(a.cancelledOrders, 'sales order')} cancelled`,
    );
  }
  const overdue = s.purchasing?.position?.overdue;
  if (overdue && overdue.count > 0) {
    attention.push(
      `${plural(overdue.count, 'purchase order')} overdue (${money(overdue.total)} still to arrive)`,
    );
  }

  return {
    companyName,
    dayLabel: longDayLabel(s.date),
    rows,
    topCustomers: s.topCustomers.slice(0, 3).map((c) => ({
      name: c.name,
      value: money(c.total),
    })),
    attention,
    quiet: s.isEmpty,
    link,
  };
}

/**
 * The owner's end-of-day digest. Hourly, for every company that switched it
 * on: once the company's local clock passes the chosen hour, the day is
 * claimed (so it goes out once, however many API instances run), and every
 * owner gets an in-app notification — plus an email when asked for.
 *
 * Modelled on StatementCronService. Switched off per process with
 * DAY_SUMMARY_WORKER_ENABLED=false.
 */
@Injectable()
export class DaySummaryCronService {
  private readonly logger = new Logger(DaySummaryCronService.name);
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly summaries: DaySummaryService,
    private readonly notifications: NotificationsService,
    private readonly mail: MailService,
  ) {}

  @Cron('10 * * * *', { name: 'day-summary-digest' })
  async hourly(): Promise<void> {
    if (!envFlag(this.config, 'DAY_SUMMARY_WORKER_ENABLED', true)) return;
    if (this.running) return;
    this.running = true;
    try {
      const n = await this.runOnce();
      if (n.sent > 0) this.logger.log(`day summaries sent: ${n.sent}`);
    } catch (err) {
      this.logger.error(`day summary run failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async runOnce(
    now: Date = new Date(),
    onlyCompanyId?: string,
  ): Promise<{ companies: number; sent: number }> {
    const companies = rowsOf(
      await this.dataSource.query(
        `SELECT cs.company_id, cs.timezone, cs.day_summary_hour,
                cs.day_summary_email, c.name, c.status,
                c.subscription_plan, c.subscription_expiry_date
           FROM company_settings cs
           JOIN companies c ON c.id = cs.company_id
          WHERE cs.day_summary_enabled = true
            ${onlyCompanyId ? 'AND cs.company_id = $1' : ''}`,
        onlyCompanyId ? [onlyCompanyId] : [],
      ),
    );

    let sent = 0;
    for (const c of companies) {
      const companyId = String(c.company_id);
      try {
        const active =
          effectiveCompanyStatus(
            {
              status: (c.status as string) ?? null,
              subscriptionPlan: (c.subscription_plan as string) ?? null,
              subscriptionExpiryDate:
                (c.subscription_expiry_date as Date | null) ?? null,
            },
            now,
          ) === 'active';
        if (!active) continue;
        const tz = businessTimezone(c.timezone as string | null);
        const day = digestDayDue(now, tz, Number(c.day_summary_hour ?? 21));
        if (!day) continue;
        if (!(await this.claim(companyId, day))) continue;
        await this.send(
          companyId,
          day,
          String(c.name ?? 'Your company'),
          Boolean(c.day_summary_email),
        );
        sent++;
      } catch (err) {
        // One company's failure must not stop everyone else's digest.
        this.logger.error(
          `day summary for ${companyId} failed: ${(err as Error).message}`,
        );
      }
    }
    return { companies: companies.length, sent };
  }

  /** Moves last_sent to `day`; false when another run already did. */
  private async claim(companyId: string, day: string): Promise<boolean> {
    const rows = rowsOf(
      await this.dataSource.query(
        `UPDATE company_settings SET day_summary_last_sent = $2
          WHERE company_id = $1 AND day_summary_enabled = true
            AND (day_summary_last_sent IS NULL OR day_summary_last_sent < $2)
          RETURNING company_id`,
        [companyId, day],
      ),
    );
    return rows.length > 0;
  }

  private async send(
    companyId: string,
    day: string,
    companyName: string,
    email: boolean,
  ): Promise<void> {
    const s = await this.summaries.summary(
      companyId,
      // The owner's view: everyone's documents, profit and voids included.
      { id: '', role: 'admin' },
      { date: day },
    );
    const link = `${this.mail.webAppUrl()}/reports/day-summary?date=${day}`;
    const content = digestContent(s, companyName, link);
    const h = s.headline;
    const money = (n: number) => digestMoney(s.currency, n);

    await this.notifications.createForRole(companyId, 'admin', {
      type: DAY_SUMMARY_NOTIFICATION,
      title: `Day summary — ${content.dayLabel}`,
      message: s.isEmpty
        ? 'Nothing was recorded on this day.'
        : `${plural(h.sales.count, 'invoice')} · ${money(h.sales.total)} sales · ${money(h.received.total)} received`,
      data: { date: day },
    });

    if (!email) return;
    const owners = rowsOf(
      await this.dataSource.query(
        `SELECT u.email FROM user_companies uc
           JOIN users u ON u.id = uc.user_id
          WHERE uc.company_id = $1 AND uc.role = 'admin'
            AND u.is_active = true AND u.is_email_verified = true
            AND u.email IS NOT NULL AND u.email <> ''`,
        [companyId],
      ),
    );
    for (const o of owners) {
      await this.mail.sendDaySummaryEmail(String(o.email), content);
    }
  }
}
