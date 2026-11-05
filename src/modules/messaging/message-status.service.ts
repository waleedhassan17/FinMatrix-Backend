import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { NotificationsService } from '../notifications/notifications.service';
import { maskPhone, toWhatsappE164 } from '../../common/utils/phone.util';
import { MessageStatus } from './messaging.constants';
import { classifyMetaError } from './meta-error-map';
import {
  inboundIntent,
  nextStatus,
  replaceableBy,
} from './message-status.util';
import { rowsOf } from './messaging.service';

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
  ): Promise<{ statuses: number; inbound: number }> {
    let statuses = 0;
    let inbound = 0;
    const entries = (body as { entry?: unknown[] })?.entry;
    if (!Array.isArray(entries)) return { statuses, inbound };
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
          if (
            (phone || userId) &&
            (await this.handleInbound({ phone, userId }, text))
          )
            inbound++;
        }
      }
    }
    return { statuses, inbound };
  }
}
