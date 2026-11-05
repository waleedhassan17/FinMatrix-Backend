import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Interval } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { Readable } from 'stream';
import { StorageService } from '../../common/storage/storage.service';
import { companyFeatures } from '../../common/features/company-features.util';
import {
  MessagingSettingsService,
  ResolvedMessagingSettings,
} from './messaging-settings.service';
import { DocumentRendererRegistry } from './document-renderer.registry';
import { MessageStatusService } from './message-status.service';
import {
  DISPATCH_BATCH,
  MAX_SEND_ATTEMPTS,
  MessageEventOrTest,
  MessageLanguage,
  MessageStatus,
  QUIET_HOURS_EXEMPT,
  REMINDER_EVENTS,
  STUCK_SENDING_MINUTES,
} from './messaging.constants';
import {
  classifyMetaError,
  ErrorClass,
  nextAttemptDelayMs,
  ProviderError,
} from './meta-error-map';
import { deferUntil, zonedPeriod } from './quiet-hours.util';
import {
  bodyParameters,
  cleanParam,
  renderPreview,
  templateByName,
  templateForEvent,
} from './templates/template-registry';
import {
  MediaFile,
  ProviderCredentials,
  WHATSAPP_PROVIDER,
  WhatsAppProvider,
} from './providers/whatsapp-provider';
import { envString, messagingWorker } from './messaging-env.util';
import { rowsOf } from './messaging.service';
import { MessageAttachment } from './entities/outbound-message.entity';

/** A message the dispatcher has claimed (status 'sending'). */
export interface ClaimedMessage {
  id: string;
  companyId: string;
  eventType: string;
  docType: string;
  docId: string;
  recipientType: 'customer' | 'vendor' | 'user';
  recipientId: string | null;
  toPhone: string | null;
  templateName: string;
  language: MessageLanguage;
  params: Record<string, unknown>;
  attachment: MessageAttachment | null;
  mediaStorageKey: string | null;
  attempts: number;
  createdBy: string | null;
}

/** An error that retrying cannot fix (missing renderer, document gone, no template). */
export class PermanentSendError extends Error {}

/**
 * The only code that talks to WhatsApp.
 *
 * Every 5 s (when MESSAGING_WORKER_ENABLED, default true) it claims up to 20
 * due rows with FOR UPDATE SKIP LOCKED in one short statement — safe with
 * several dynos — and then works on each OUTSIDE any transaction: re-checks,
 * quiet hours, render + store the PDF, upload, send.
 */
@Injectable()
export class MessagingDispatcherService {
  private readonly logger = new Logger(MessagingDispatcherService.name);
  private running = false;

  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
    private readonly settings: MessagingSettingsService,
    private readonly renderers: DocumentRendererRegistry,
    private readonly storage: StorageService,
    private readonly status: MessageStatusService,
    @Inject(WHATSAPP_PROVIDER) private readonly provider: WhatsAppProvider,
  ) {}

  @Interval('messaging-dispatcher', 5_000)
  async tick(): Promise<void> {
    if (!messagingWorker(this.config) || this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (err) {
      this.logger.error(`dispatch tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  /** One pass: return stuck rows, claim a batch, process it. Exposed for tests. */
  async runOnce(now: Date = new Date()): Promise<Record<string, number>> {
    await this.returnStuck();
    const claimed = await this.claim();
    const outcome: Record<string, number> = {};
    for (const row of claimed) {
      let result: string;
      try {
        result = await this.processOne(row, now);
      } catch (err) {
        result = await this.handleError(row, err);
      }
      outcome[result] = (outcome[result] ?? 0) + 1;
    }
    return outcome;
  }

  async returnStuck(): Promise<number> {
    const res = await this.dataSource.query(
      `UPDATE outbound_messages SET status = 'queued', updated_at = now()
        WHERE status = 'sending' AND updated_at < now() - ($1 || ' minutes')::interval
        RETURNING id`,
      [String(STUCK_SENDING_MINUTES)],
    );
    const n = rowsOf(res).length;
    if (n > 0)
      this.logger.warn(
        `${n} message(s) stuck in sending returned to the queue`,
      );
    return n;
  }

  async claim(): Promise<ClaimedMessage[]> {
    const res = await this.dataSource.query(
      `UPDATE outbound_messages SET status = 'sending', updated_at = now()
        WHERE id IN (
          SELECT id FROM outbound_messages
           WHERE status = 'queued' AND next_attempt_at <= now()
             AND (scheduled_for IS NULL OR scheduled_for <= now())
           ORDER BY next_attempt_at, created_at
           LIMIT $1
           FOR UPDATE SKIP LOCKED)
        RETURNING *`,
      [DISPATCH_BATCH],
    );
    return rowsOf(res).map((r) => ({
      id: String(r.id),
      companyId: String(r.company_id),
      eventType: String(r.event_type),
      docType: String(r.doc_type),
      docId: String(r.doc_id),
      recipientType: r.recipient_type as ClaimedMessage['recipientType'],
      recipientId: (r.recipient_id as string | null) ?? null,
      toPhone: (r.to_phone_e164 as string | null) ?? null,
      templateName: String(r.template_name),
      language: (r.language as MessageLanguage) ?? 'en',
      params: (r.params as Record<string, unknown>) ?? {},
      attachment: (r.attachment as MessageAttachment | null) ?? null,
      mediaStorageKey: (r.media_storage_key as string | null) ?? null,
      attempts: Number(r.attempts ?? 0),
      createdBy: (r.created_by as string | null) ?? null,
    }));
  }

  async processOne(
    row: ClaimedMessage,
    now: Date = new Date(),
  ): Promise<string> {
    const s = await this.settings.resolve(row.companyId);
    const features = await companyFeatures(
      this.dataSource.manager,
      row.companyId,
    );
    if (!features.whatsappConnect)
      return this.finish(row, 'skipped', 'feature_off');
    if (!s.enabled && row.eventType !== 'test')
      return this.finish(row, 'skipped', 'connect_disabled');

    const stale = await this.staleReason(row);
    if (stale) return this.finish(row, stale.status, stale.reason);

    if (!QUIET_HOURS_EXEMPT.includes(row.eventType as MessageEventOrTest)) {
      const until = deferUntil(now, s.timezone, s.quietHours);
      if (until) {
        await this.dataSource.query(
          `UPDATE outbound_messages
              SET status = 'queued', scheduled_for = $2, last_error = 'quiet_hours', updated_at = now()
            WHERE id = $1 AND status = 'sending'`,
          [row.id, until],
        );
        return 'deferred';
      }
    }

    if (s.monthlyCap !== null && row.eventType !== 'test') {
      const used = rowsOf(
        await this.dataSource.query(
          `SELECT COALESCE(SUM(count), 0) AS used FROM messaging_usage WHERE company_id = $1 AND period = $2`,
          [row.companyId, zonedPeriod(now, s.timezone)],
        ),
      );
      if (Number(used[0]?.used ?? 0) >= s.monthlyCap)
        return this.finish(row, 'skipped', 'cap_reached');
    }

    if (!row.toPhone) return this.finish(row, 'skipped', 'no_number');

    const template =
      templateByName(row.templateName) ??
      templateForEvent(row.eventType as MessageEventOrTest);
    const creds = this.credentials(s);

    let documentHeader: { mediaId: string; filename: string } | null = null;
    if (template.header === 'DOCUMENT') {
      if (!row.attachment)
        throw new PermanentSendError(
          'This message needs a PDF and none was attached',
        );
      const file = await this.attachmentFile(row);
      const mediaId = await this.provider.uploadMedia(creds, file);
      documentHeader = { mediaId, filename: file.filename };
    }

    const { providerMessageId } = await this.provider.sendTemplate(creds, {
      to: row.toPhone,
      templateName: template.name,
      language: row.language,
      documentHeader,
      bodyParams: bodyParameters(template, row.params),
      urlButtonParam: template.urlButton
        ? cleanParam(row.params[template.urlButton.param])
        : null,
      preview: renderPreview(template, row.language, row.params),
    });

    await this.dataSource.query(
      `UPDATE outbound_messages
          SET status = 'sent', provider_message_id = $2, attempts = attempts + 1,
              last_error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'sending'`,
      [row.id, providerMessageId],
    );
    await this.dataSource.query(
      `INSERT INTO message_status_events (message_id, status, occurred_at, raw) VALUES ($1, 'sent', now(), $2::jsonb)`,
      [
        row.id,
        JSON.stringify({ providerMessageId, provider: this.provider.kind }),
      ],
    );
    await this.dataSource.query(
      `INSERT INTO messaging_usage (company_id, period, category, count, updated_at)
       VALUES ($1, $2, $3, 1, now())
       ON CONFLICT (company_id, period, category)
       DO UPDATE SET count = messaging_usage.count + 1, updated_at = now()`,
      [
        row.companyId,
        zonedPeriod(now, s.timezone),
        template.category.toLowerCase(),
      ],
    );
    return 'sent';
  }

  /** Why a queued message must not go after all (state changed since it was queued). */
  private async staleReason(
    row: ClaimedMessage,
  ): Promise<{ status: MessageStatus; reason: string } | null> {
    if (row.recipientType === 'customer' || row.recipientType === 'vendor') {
      const table = row.recipientType === 'customer' ? 'customers' : 'vendors';
      const extra =
        row.recipientType === 'customer' ? ', collections_paused' : '';
      const c = rowsOf(
        await this.dataSource.query(
          `SELECT whatsapp_opt_out, whatsapp_e164${extra} FROM ${table} WHERE id = $1 AND company_id = $2`,
          [row.recipientId, row.companyId],
        ),
      )[0];
      if (!c) return { status: 'cancelled', reason: 'contact_removed' };
      if (c.whatsapp_opt_out) return { status: 'skipped', reason: 'opted_out' };
      if ((c.whatsapp_e164 ?? null) !== row.toPhone)
        return { status: 'cancelled', reason: 'number_changed' };
      const collections =
        REMINDER_EVENTS.includes(row.eventType as never) ||
        row.eventType === 'statement';
      if (collections && c.collections_paused)
        return { status: 'cancelled', reason: 'collections_paused' };
    }
    if (
      REMINDER_EVENTS.includes(row.eventType as never) &&
      row.docType === 'invoice'
    ) {
      const inv = rowsOf(
        await this.dataSource.query(
          `SELECT status, balance FROM invoices WHERE id = $1 AND company_id = $2`,
          [row.docId, row.companyId],
        ),
      )[0];
      if (
        !inv ||
        ['void', 'paid', 'draft'].includes(String(inv.status)) ||
        Number(inv.balance) <= 0
      ) {
        return { status: 'cancelled', reason: 'invoice_settled' };
      }
    }
    return null;
  }

  private async attachmentFile(row: ClaimedMessage): Promise<MediaFile> {
    const filename = safeFilename(
      String(row.attachment?.args?.filename ?? ''),
      row,
    );
    if (row.mediaStorageKey) {
      // A retry sends exactly the copy stored on the first attempt.
      const stored = await this.storage.read(row.mediaStorageKey);
      if (stored)
        return {
          buffer: await streamToBuffer(stored.stream),
          filename,
          mimeType: 'application/pdf',
        };
    }
    const renderer = this.renderers.get(row.attachment!.renderer);
    if (!renderer)
      throw new PermanentSendError(
        `No PDF renderer named ${row.attachment!.renderer}`,
      );
    let rendered;
    try {
      rendered = await renderer.render(
        row.companyId,
        row.attachment!.args ?? {},
      );
    } catch (err) {
      throw new PermanentSendError(
        `The PDF could not be produced: ${(err as Error).message}`,
      );
    }
    const stored = await this.storage.putBuffer({
      bucket: 'outbound-messages',
      buffer: rendered.buffer,
      mimeType: 'application/pdf',
      originalName: rendered.filename || filename,
      publicPath: `/messages/${row.id}/media`,
    });
    await this.dataSource.query(
      `UPDATE outbound_messages SET media_storage_key = $2 WHERE id = $1`,
      [row.id, stored.key],
    );
    return {
      buffer: rendered.buffer,
      filename: rendered.filename || filename,
      mimeType: 'application/pdf',
    };
  }

  private credentials(s: ResolvedMessagingSettings): ProviderCredentials {
    const graphVersion = envString(this.config, 'WHATSAPP_GRAPH_VERSION');
    if (s.senderMode === 'own') {
      return {
        phoneNumberId: s.phoneNumberId ?? '',
        accessToken: this.settings.ownAccessToken(s) ?? '',
        graphVersion,
      };
    }
    return {
      phoneNumberId: envString(this.config, 'WHATSAPP_PHONE_NUMBER_ID'),
      accessToken: envString(this.config, 'WHATSAPP_ACCESS_TOKEN'),
      graphVersion,
    };
  }

  private async finish(
    row: ClaimedMessage,
    status: MessageStatus,
    reason: string,
  ): Promise<string> {
    await this.dataSource.query(
      `UPDATE outbound_messages SET status = $2, last_error = $3, updated_at = now()
        WHERE id = $1 AND status = 'sending'`,
      [row.id, status, reason],
    );
    return `${status}:${reason}`;
  }

  async handleError(row: ClaimedMessage, err: unknown): Promise<string> {
    const cls: ErrorClass =
      err instanceof ProviderError
        ? classifyMetaError({
            code: err.code,
            httpStatus: err.httpStatus,
            message: err.message,
          })
        : err instanceof PermanentSendError
          ? { retryable: false, reason: err.message }
          : {
              retryable: true,
              reason: (err as Error)?.message ?? 'Unexpected error; will retry',
            };
    const attempts = row.attempts + 1;
    if (cls.retryable && attempts < MAX_SEND_ATTEMPTS) {
      await this.dataSource.query(
        `UPDATE outbound_messages
            SET status = 'queued', attempts = $2, last_error = $3,
                next_attempt_at = now() + ($4 || ' milliseconds')::interval, updated_at = now()
          WHERE id = $1 AND status = 'sending'`,
        [row.id, attempts, cls.reason, String(nextAttemptDelayMs(attempts))],
      );
      this.logger.warn(
        `message ${row.id} attempt ${attempts} failed, will retry: ${cls.reason}`,
      );
      return 'retry';
    }
    await this.dataSource.query(
      `UPDATE outbound_messages SET status = 'failed', attempts = $2, last_error = $3, updated_at = now()
        WHERE id = $1 AND status = 'sending'`,
      [row.id, attempts, cls.reason],
    );
    await this.dataSource.query(
      `INSERT INTO message_status_events (message_id, status, occurred_at, error_code, raw)
       VALUES ($1, 'failed', now(), $2, $3::jsonb)`,
      [
        row.id,
        err instanceof ProviderError && err.code !== null
          ? String(err.code)
          : null,
        JSON.stringify({ reason: cls.reason }),
      ],
    );
    if (
      cls.clearsVerification &&
      row.recipientId &&
      row.recipientType !== 'user'
    ) {
      await this.status.clearVerification(
        row.recipientType === 'customer' ? 'customers' : 'vendors',
        row.recipientId,
        row.toPhone,
      );
    }
    await this.status.notifyFailure(
      {
        id: row.id,
        companyId: row.companyId,
        eventType: row.eventType,
        docType: row.docType,
        docId: row.docId,
        toPhone: row.toPhone,
        createdBy: row.createdBy,
      },
      cls.reason,
    );
    this.logger.warn(`message ${row.id} failed: ${cls.reason}`);
    return 'failed';
  }
}

function streamToBuffer(stream: Readable): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (c) =>
      chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)),
    );
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function safeFilename(name: string, row: ClaimedMessage): string {
  const base =
    (name || `${row.docType}-${row.docId.slice(0, 8)}`)
      .replace(/[^\w.\- ]+/g, '')
      .trim() || 'document';
  return base.toLowerCase().endsWith('.pdf') ? base : `${base}.pdf`;
}
