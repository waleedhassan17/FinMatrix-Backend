import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NotificationsService } from '../notifications/notifications.service';
import { maskPhone, toWhatsappE164 } from '../../common/utils/phone.util';
import { MessageLanguage, MessageStatus } from './messaging.constants';
import { classifyMetaError } from './meta-error-map';
import {
  inboundIntent,
  nextStatus,
  replaceableBy,
} from './message-status.util';
import { MessagingService, rowsOf } from './messaging.service';
import { inboundReply } from './inbound-reply';
import { businessToday } from '../../common/utils/business-date.util';

/** Inbound message types that never get an automatic answer. */
const NO_REPLY_TYPES = new Set(['reaction', 'system', 'unsupported']);

export interface ProviderStatusUpdate {
  providerMessageId: string;
  status: MessageStatus;
  occurredAt?: Date;
  raw?: Record<string, unknown> | null;
  errorCode?: string | number | null;
  errorTitle?: string | null;
  /** statuses[].recipient_user_id: WhatsApp's user id for the recipient. */
  recipientUserId?: string | null;
}

/** A non-empty string from a webhook field, else null. */
const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() !== ''
    ? v.trim()
    : typeof v === 'number'
      ? String(v)
      : null;

const EVENT_LABEL: Record<string, string> = {
  invoice_issued: 'Invoice',
  invoice_revised: 'Revised invoice',
  invoice_cancelled: 'Invoice cancellation',
  payment_received: 'Payment receipt',
  po_issued: 'Purchase order',
  po_cancelled: 'Purchase order withdrawal',
  remittance: 'Remittance advice',
  approval_pending: 'Approval alert',
  reminder_upcoming: 'Payment reminder',
  reminder_overdue: 'Overdue reminder',
  statement: 'Statement',
  delivery_update: 'Delivery update',
  test: 'Test message',
  auto_reply: 'Automatic reply',
};

export const eventLabel = (event: string) =>
  EVENT_LABEL[event] ?? 'WhatsApp message';

/**
 * Everything that changes a message after it left: provider status updates
 * (from Meta's webhook, or the fake provider through this same path), failure
 * alerts to the owner, and STOP / START replies from contacts.
 */
@Injectable()
export class MessageStatusService {
  private readonly logger = new Logger(MessageStatusService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly notifications: NotificationsService,
    private readonly messaging: MessagingService,
  ) {}

  /** Returns 'unknown' when no message has that provider id. */
  async applyProviderStatus(
    u: ProviderStatusUpdate,
  ): Promise<'applied' | 'recorded' | 'unknown'> {
    const rows = rowsOf(
      await this.dataSource.query(
        `SELECT id, company_id, status, event_type, doc_type, doc_id, recipient_type, recipient_id,
                to_phone_e164, created_by
           FROM outbound_messages WHERE provider_message_id = $1 LIMIT 1`,
        [u.providerMessageId],
      ),
    );
    const row = rows[0];
    if (!row) {
      this.logger.warn(
        `status ${u.status} for unknown message ${u.providerMessageId}`,
      );
      return 'unknown';
    }
    const errorCode =
      u.errorCode === undefined || u.errorCode === null
        ? null
        : String(u.errorCode);
    await this.dataSource.query(
      `INSERT INTO message_status_events (message_id, status, occurred_at, raw, error_code)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [
        row.id,
        u.status,
        u.occurredAt ?? new Date(),
        u.raw ? JSON.stringify(u.raw) : null,
        errorCode,
      ],
    );

    const target = nextStatus(row.status as MessageStatus, u.status);
    let applied = false;
    let reason: string | null = null;
    if (target) {
      if (target === 'failed') {
        reason = classifyMetaError({
          code: errorCode,
          httpStatus: 400,
          message: u.errorTitle,
        }).reason;
      }
      const updated = rowsOf(
        await this.dataSource.query(
          `UPDATE outbound_messages
              SET status = $2::varchar,
                  last_error = CASE WHEN $2::varchar = 'failed' THEN $3::text ELSE last_error END,
                  updated_at = now()
            WHERE id = $1 AND status = ANY($4::text[])
          RETURNING id`,
          [row.id, target, reason, replaceableBy(target)],
        ),
      );
      applied = updated.length > 0;
    }

    const party =
      row.recipient_type === 'customer'
        ? 'customers'
        : row.recipient_type === 'vendor'
          ? 'vendors'
          : null;
    if (
      party &&
      row.recipient_id &&
      (u.status === 'delivered' || u.status === 'read')
    ) {
      // Delivered proves the number is on WhatsApp — as long as it is still the number we sent to.
      await this.dataSource.query(
        `UPDATE ${party} SET whatsapp_verified_at = now()
          WHERE id = $1 AND whatsapp_e164 = $2`,
        [row.recipient_id, row.to_phone_e164],
      );
    }
    if (
      party &&
      row.recipient_id &&
      u.recipientUserId &&
      u.status !== 'failed'
    ) {
      // Remember WhatsApp's user id for this contact (still on the number we
      // sent to), so a later STOP that carries no phone number still finds them.
      await this.dataSource.query(
        `UPDATE ${party} SET whatsapp_user_id = $3::varchar
          WHERE id = $1 AND whatsapp_e164 = $2
            AND whatsapp_user_id IS DISTINCT FROM $3::varchar`,
        [row.recipient_id, row.to_phone_e164, u.recipientUserId.slice(0, 160)],
      );
    }

    if (applied && target === 'failed') {
      const cls = classifyMetaError({
        code: errorCode,
        httpStatus: 400,
        message: u.errorTitle,
      });
      if (cls.clearsVerification && party && row.recipient_id) {
        await this.clearVerification(
          party,
          String(row.recipient_id),
          row.to_phone_e164 as string | null,
        );
      }
      await this.notifyFailure(
        {
          id: String(row.id),
          companyId: String(row.company_id),
          eventType: String(row.event_type),
          docType: String(row.doc_type),
          docId: String(row.doc_id),
          toPhone: (row.to_phone_e164 as string | null) ?? null,
          createdBy: (row.created_by as string | null) ?? null,
        },
        cls.reason,
      );
    }
    return applied ? 'applied' : 'recorded';
  }

  async clearVerification(
    party: 'customers' | 'vendors',
    id: string,
    phone: string | null,
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE ${party} SET whatsapp_verified_at = NULL WHERE id = $1 AND ($2::text IS NULL OR whatsapp_e164 = $2)`,
      [id, phone],
    );
  }

  /** In-app alert for a message that will not arrive: its sender, else every owner. */
  /** Owners' notice that the plan's WhatsApp allowance is nearly or fully used. */
  async notifyAllowance(
    companyId: string,
    a: { used: number; limit: number; period: string; full: boolean },
  ): Promise<void> {
    try {
      await this.notifications.createForRole(companyId, 'admin', {
        type: 'whatsapp_allowance',
        title: a.full
          ? 'WhatsApp allowance used up for this month'
          : 'WhatsApp allowance 80% used',
        message: a.full
          ? `All ${a.limit} WhatsApp messages included in your plan have been sent this month. ` +
            'Documents will not go out on WhatsApp until next month; you can still share them by hand.'
          : `${a.used} of the ${a.limit} WhatsApp messages included in your plan have been sent this month.`,
        data: { period: a.period, used: a.used, limit: a.limit },
      });
    } catch (err) {
      this.logger.warn(
        `allowance notice not written: ${(err as Error).message}`,
      );
    }
  }

  /**
   * A contact wrote to the FinMatrix number (not STOP / START). Find the
   * company that messaged this number last (within 30 days) and queue one
   * automatic answer with that company's contact details (decision D36).
   * Owners' approval alerts are not answered, nor is a number nobody here
   * has messaged. Returns true when a new reply was queued.
   */
  async replyToInbound(from: {
    phone?: string | null;
    userId?: string | null;
  }): Promise<boolean> {
    try {
      const raw = (from.phone ?? '').trim();
      const phones: string[] = [];
      const e164 = raw
        ? toWhatsappE164(raw.startsWith('+') ? raw : `+${raw}`)
        : null;
      if (e164) phones.push(e164);
      else if (from.userId) {
        for (const table of ['customers', 'vendors']) {
          for (const r of rowsOf(
            await this.dataSource.query(
              `SELECT DISTINCT whatsapp_e164 FROM ${table}
                WHERE whatsapp_user_id = $1 AND whatsapp_e164 IS NOT NULL`,
              [from.userId],
            ),
          ))
            phones.push(String(r.whatsapp_e164));
        }
      }
      if (phones.length === 0) return false;

      const last = rowsOf(
        await this.dataSource.query(
          `SELECT company_id, doc_type, doc_id, recipient_type, recipient_id, to_phone_e164, language
             FROM outbound_messages
            WHERE to_phone_e164 = ANY($1::text[]) AND channel = 'whatsapp_api'
              AND status IN ('sent','delivered','read')
              AND recipient_type IN ('customer','vendor') AND recipient_id IS NOT NULL
              AND event_type <> 'auto_reply'
              AND created_at > now() - interval '30 days'
            ORDER BY created_at DESC
            LIMIT 1`,
          [phones],
        ),
      )[0];
      if (!last) return false;

      const party = last.recipient_type === 'vendor' ? 'vendors' : 'customers';
      const contact = rowsOf(
        await this.dataSource.query(
          `SELECT whatsapp_opt_out, whatsapp_e164 FROM ${party} WHERE id = $1 AND company_id = $2`,
          [last.recipient_id, last.company_id],
        ),
      )[0];
      // Respect a STOP; and only while they still have the number we wrote to.
      if (
        !contact ||
        contact.whatsapp_opt_out ||
        contact.whatsapp_e164 !== last.to_phone_e164
      )
        return false;

      const company = rowsOf(
        await this.dataSource.query(
          `SELECT name, phone, email FROM companies WHERE id = $1`,
          [last.company_id],
        ),
      )[0];
      const language: MessageLanguage = last.language === 'ur' ? 'ur' : 'en';
      const reply = inboundReply({
        companyName: String(company?.name ?? ''),
        companyPhone: (company?.phone as string | null) ?? null,
        companyEmail: (company?.email as string | null) ?? null,
        language,
      });
      if (!reply) return false;

      const res = await this.messaging.enqueueAutoReply({
        companyId: String(last.company_id),
        docType: String(last.doc_type),
        docId: String(last.doc_id),
        recipient: {
          type: last.recipient_type === 'vendor' ? 'vendor' : 'customer',
          id: String(last.recipient_id),
        },
        toPhone: String(last.to_phone_e164),
        language,
        text: reply.text,
        day: businessToday(),
      });
      return Boolean(res && !res.duplicate);
    } catch (err) {
      this.logger.warn(`auto-reply not queued: ${(err as Error).message}`);
      return false;
    }
  }

  async notifyFailure(
    m: {
      id: string;
      companyId: string;
      eventType: string;
      docType: string;
      docId: string;
      toPhone: string | null;
      createdBy: string | null;
    },
    reason: string,
  ): Promise<void> {
    const payload = {
      type: 'whatsapp_failed',
      title: `${eventLabel(m.eventType)} not delivered on WhatsApp`,
      message: `To ${maskPhone(m.toPhone)}: ${reason}`,
      data: {
        messageId: m.id,
        docType: m.docType,
        docId: m.docId,
        eventType: m.eventType,
      },
    };
    try {
      if (m.createdBy) {
        await this.notifications.create({
          companyId: m.companyId,
          userId: m.createdBy,
          ...payload,
        });
      } else {
        await this.notifications.createForRole(m.companyId, 'admin', payload);
      }
    } catch (err) {
      this.logger.warn(`failure alert not written: ${(err as Error).message}`);
    }
  }

  /**
   * A contact replied. STOP / UNSUBSCRIBE opts the contact out on every
   * customer and vendor holding that number or WhatsApp user id (every
   * company: over-honouring a STOP is the safe side) and cancels anything
   * still queued to them. START / SUBSCRIBE lifts the opt-out (decision D16:
   * only the contact can).
   *
   * Since 2026 a contact with a WhatsApp username can arrive without a phone
   * number, only a business-scoped user id (BSUID). Either one is enough; a
   * message carrying both teaches us the id for that number.
   */
  async handleInbound(
    from: { phone?: string | null; userId?: string | null },
    text: string | null | undefined,
  ): Promise<'stop' | 'start' | null> {
    const raw = (from.phone ?? '').trim();
    const phone = raw
      ? toWhatsappE164(raw.startsWith('+') ? raw : `+${raw}`)
      : null;
    const userId = (from.userId ?? '').trim().slice(0, 160) || null;
    if (phone && userId) {
      for (const table of ['customers', 'vendors']) {
        await this.dataSource.query(
          `UPDATE ${table} SET whatsapp_user_id = $2::varchar
            WHERE whatsapp_e164 = $1 AND whatsapp_user_id IS DISTINCT FROM $2::varchar`,
          [phone, userId],
        );
      }
    }
    const intent = inboundIntent(text);
    if (!intent || (!phone && !userId)) return null;
    const optOut = intent === 'stop';
    const phones = new Set<string>(phone ? [phone] : []);
    for (const table of ['customers', 'vendors']) {
      const hit = rowsOf(
        await this.dataSource.query(
          `UPDATE ${table} SET whatsapp_opt_out = $3
            WHERE whatsapp_e164 = $1::varchar
               OR ($2::varchar IS NOT NULL AND whatsapp_user_id = $2::varchar)
          RETURNING whatsapp_e164`,
          [phone, userId, optOut],
        ),
      );
      for (const r of hit)
        if (r.whatsapp_e164) phones.add(String(r.whatsapp_e164));
    }
    if (optOut && phones.size > 0) {
      await this.dataSource.query(
        `UPDATE outbound_messages SET status = 'cancelled', last_error = 'opted_out', updated_at = now()
          WHERE to_phone_e164 = ANY($1::text[]) AND status = 'queued' AND recipient_type <> 'user'`,
        [[...phones]],
      );
    }
    this.logger.log(
      `inbound ${intent.toUpperCase()} from ${phone ? maskPhone(phone) : 'a WhatsApp user id'}`,
    );
    return intent;
  }

  /** Meta's webhook body: statuses and inbound messages, every entry and change. */
  async processWebhook(
    body: unknown,
  ): Promise<{ statuses: number; inbound: number; replies: number }> {
    let statuses = 0;
    let inbound = 0;
    let replies = 0;
    const entries = (body as { entry?: unknown[] })?.entry;
    if (!Array.isArray(entries)) return { statuses, inbound, replies };
    for (const entry of entries) {
      const changes = (entry as { changes?: unknown[] })?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const value =
          (change as { value?: Record<string, unknown> })?.value ?? {};
        for (const s of (value.statuses as Array<Record<string, unknown>>) ??
          []) {
          const status = String(s.status ?? '') as MessageStatus;
          if (
            !['sent', 'delivered', 'read', 'failed'].includes(status) ||
            !s.id
          )
            continue;
          const err = Array.isArray(s.errors)
            ? (s.errors[0] as Record<string, unknown>)
            : null;
          await this.applyProviderStatus({
            providerMessageId: String(s.id),
            status,
            occurredAt: s.timestamp
              ? new Date(Number(s.timestamp) * 1000)
              : new Date(),
            raw: s,
            errorCode: (err?.code as number | undefined) ?? null,
            errorTitle:
              (err?.title as string | undefined) ??
              (err?.message as string | undefined) ??
              null,
            recipientUserId: str(s.recipient_user_id),
          });
          statuses++;
        }
        const contacts =
          (value.contacts as Array<Record<string, unknown>> | undefined) ?? [];
        for (const msg of (value.messages as Array<Record<string, unknown>>) ??
          []) {
          const text =
            (msg.text as { body?: string } | undefined)?.body ??
            (msg.button as { text?: string } | undefined)?.text ??
            null;
          // `from` / `wa_id` may be missing for a contact with a username;
          // `from_user_id` (the BSUID) is then the only key.
          const fromUserId = str(msg.from_user_id);
          const contact =
            contacts.find(
              (c) => fromUserId !== null && str(c.user_id) === fromUserId,
            ) ?? (contacts.length === 1 ? contacts[0] : undefined);
          const phone = str(msg.from) ?? str(contact?.wa_id);
          const userId = fromUserId ?? str(contact?.user_id);
          if (!phone && !userId) continue;
          if (await this.handleInbound({ phone, userId }, text)) {
            inbound++;
          } else if (!NO_REPLY_TYPES.has(String(msg.type ?? 'text'))) {
            // Anything else they wrote: point them to the company (D36).
            if (await this.replyToInbound({ phone, userId })) replies++;
          }
        }
      }
    }
    return { statuses, inbound, replies };
  }
}
