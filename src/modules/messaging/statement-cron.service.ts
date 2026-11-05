import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { companyFeatures } from '../../common/features/company-features.util';
import { PartyLedgerService } from '../ledger/party-ledger.service';
import { MessagingService, rowsOf } from './messaging.service';
import { MessagingSettingsService } from './messaging-settings.service';
import { messagingWorker } from './messaging-env.util';
import { statementWindow } from './collections.util';
import { statementMessage } from './document-messages';
import { toDecimal } from '../../common/utils/money.util';

/**
 * Monthly statements on WhatsApp: on the 1st from 09:00 company time, every
 * customer whose statement for the month just ended closes with a balance
 * owed. The closing balance is PartyLedgerService.statement's — the same
 * figure the statement PDF prints — not a new query. Off by default; runs
 * only for a rule of 'auto' (D24).
 */
@Injectable()
export class StatementCronService {
  private readonly logger = new Logger(StatementCronService.name);
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly settings: MessagingSettingsService,
    private readonly messaging: MessagingService,
    private readonly ledger: PartyLedgerService,
  ) {}

  @Cron('5 * * * *', { name: 'messaging-statements' })
  async hourly(): Promise<void> {
    if (!messagingWorker(this.config) || this.running) return;
    this.running = true;
    try {
      const n = await this.runOnce();
      if (n.queued > 0) this.logger.log(`statements queued: ${n.queued}`);
    } catch (err) {
      this.logger.error(`statement run failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async runOnce(
    now: Date = new Date(),
    onlyCompanyId?: string,
  ): Promise<{ customers: number; queued: number }> {
    const companies = rowsOf(
      await this.dataSource.query(
        `SELECT company_id FROM company_messaging_settings WHERE enabled = true
           ${onlyCompanyId ? 'AND company_id = $1' : ''}`,
        onlyCompanyId ? [onlyCompanyId] : [],
      ),
    ).map((r) => String(r.company_id));

    let customers = 0;
    let queued = 0;
    for (const companyId of companies) {
      const features = await companyFeatures(
        this.dataSource.manager,
        companyId,
      );
      if (!features.whatsappConnect) continue;
      const s = await this.settings.resolve(companyId);
      if (s.eventRules.statement !== 'auto') continue;
      const window = statementWindow(now, s.timezone);
      if (!window) continue;

      // Candidates: customers who owe something now. The statement itself
      // decides (its closing balance for the period must be owed too).
      const list = rowsOf(
        await this.dataSource.query(
          `SELECT id FROM customers
            WHERE company_id = $1 AND is_active = true AND balance > 0
              AND whatsapp_opt_out = false AND collections_paused = false`,
          [companyId],
        ),
      );
      for (const c of list) {
        customers++;
        const st = await this.ledger.statement(
          companyId,
          'customer',
          String(c.id),
          window.start,
          window.end,
        );
        if (!toDecimal(st.closingBalance).greaterThan('0.005')) continue;
        const res = await this.messaging.enqueue(
          null,
          statementMessage(
            {
              companyId,
              customerId: String(c.id),
              closingBalance: st.closingBalance,
            },
            window,
          ),
        );
        if (res && !res.duplicate && res.status === 'queued') queued++;
      }
    }
    return { customers, queued };
  }
}
