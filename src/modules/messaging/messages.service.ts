import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import Decimal from 'decimal.js';
import { StorageService } from '../../common/storage/storage.service';
import { maskPhone, toWhatsappE164 } from '../../common/utils/phone.util';
import { daysBetweenIso } from '../../common/utils/business-date.util';
import { formatRupees, toDecimal } from '../../common/utils/money.util';
import { pdfDate } from '../../common/pdf/document-pdf.util';
import { PartyLedgerService } from '../ledger/party-ledger.service';
import { ReportsKpiService } from '../reports/reports-kpi.service';
import {
  EnqueueInput,
  EnqueueRecipient,
  EnqueueResult,
  MessagingService,
  rowsOf,
} from './messaging.service';
import { MessagingSettingsService } from './messaging-settings.service';
import {
  DocType,
  MessageEventOrTest,
  MessageStatus,
} from './messaging.constants';
import { eventLabel } from './message-status.service';
import { renderPreview, templateByName } from './templates/template-registry';
import { zonedPeriod } from './quiet-hours.util';
import { zonedToday } from './collections.util';
import {
  invoiceIssuedMessage,
  paymentReceivedMessage,
  poIssuedMessage,
  reminderMessage,
  remittanceMessage,
  statementMessage,
} from './document-messages';

/** Why a message did not go, in words a person reads on the timeline. */
const REASONS: Record<string, string> = {
  feature_off: 'WhatsApp Connect is not part of this plan',
  connect_disabled: 'WhatsApp Connect is switched off',
  rule_off: 'Automatic sending is off for this kind of message',
  rule_manual: 'Set to ask each time — press Send to deliver it',
  no_number: 'No WhatsApp number on the contact',
  opted_out: 'The contact replied STOP',
  no_consent: 'No WhatsApp consent recorded for the contact',
  cap_reached: "This month's message limit was reached",
  invoice_void: 'The invoice was voided',
  document_changed: 'The document changed before it was sent',
  po_withdrawn: 'The purchase order was withdrawn',
  payment_recorded: 'A payment was recorded first',
  invoice_settled: 'The invoice was settled first',
  collections_paused: 'Reminders are paused for this customer',
  number_changed: 'The contact’s number changed before it was sent',
  contact_removed: 'The contact no longer exists',
  quiet_hours: 'Waiting for quiet hours to end',
};

export const reasonText = (code: string | null | undefined): string | null =>
  code ? (REASONS[code] ?? code) : null;

/** Which party a document's messages go to. */
const PARTY_OF: Record<
  string,
  { sql: string; type: 'customer' | 'vendor'; event: MessageEventOrTest }
> = {
  invoice: {
    sql: `SELECT customer_id AS party FROM invoices WHERE id = $1 AND company_id = $2`,
    type: 'customer',
    event: 'invoice_issued',
  },
  payment: {
    sql: `SELECT customer_id AS party FROM payments WHERE id = $1 AND company_id = $2`,
    type: 'customer',
    event: 'payment_received',
  },
  purchase_order: {
    sql: `SELECT vendor_id AS party FROM purchase_orders WHERE id = $1 AND company_id = $2`,
    type: 'vendor',
    event: 'po_issued',
  },
  bill_payment: {
    sql: `SELECT vendor_id AS party FROM bill_payments WHERE id = $1 AND company_id = $2`,
    type: 'vendor',
    event: 'remittance',
  },
  customer_statement: {
    sql: `SELECT id AS party FROM customers WHERE id = $1 AND company_id = $2`,
    type: 'customer',
    event: 'statement',
  },
};

export interface ContactHealthRow {
  partyType: 'customer' | 'vendor';
  id: string;
  code: string | null;
  name: string;
  phone: string | null;
  whatsappE164: string | null;
  status:
    | 'ready'
    | 'unverified'
    | 'no_consent'
    | 'missing'
    | 'invalid'
    | 'not_on_whatsapp'
    | 'opted_out';
  optInAt: string | null;
  verifiedAt: string | null;
}

/**
 * The Connect API behind MessagesController: timelines, resend, explicit
 * send, manual-share logging, stats and contact health. Reads documents
 * with plain SQL so this module imports no accounting module.
 */
@Injectable()
export class MessagesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly messaging: MessagingService,
    private readonly settings: MessagingSettingsService,
    private readonly storage: StorageService,
    private readonly ledger: PartyLedgerService,
    private readonly kpis: ReportsKpiService,
  ) {}

  /** A document's messages, newest first, each with its provider history. */
  async timeline(companyId: string, docType: string, docId: string) {
    const rows = rowsOf(
      await this.dataSource.query(
        `SELECT * FROM outbound_messages
          WHERE company_id = $1 AND doc_type = $2 AND doc_id = $3
          ORDER BY created_at DESC, id DESC`,
        [companyId, docType, docId],
      ),
    );
    const ids = rows.map((r) => String(r.id));
    const events = ids.length
      ? rowsOf(
          await this.dataSource.query(
            `SELECT message_id, status, occurred_at, error_code FROM message_status_events
              WHERE message_id = ANY($1::uuid[]) ORDER BY occurred_at, created_at`,
            [ids],
          ),
        )
      : [];
    const byMessage = new Map<
      string,
      Array<{ status: string; occurredAt: string; errorCode: string | null }>
    >();
    for (const e of events) {
      const list = byMessage.get(String(e.message_id)) ?? [];
      list.push({
        status: String(e.status),
        occurredAt: new Date(e.occurred_at as string).toISOString(),
        errorCode: (e.error_code as string | null) ?? null,
      });
      byMessage.set(String(e.message_id), list);
    }
    return {
      messages: rows.map((r) =>
        this.view(r, byMessage.get(String(r.id)) ?? []),
      ),
    };
  }

  private view(
    r: Record<string, unknown>,
    events: Array<{
      status: string;
      occurredAt: string;
      errorCode: string | null;
    }>,
  ) {
    const status = r.status as MessageStatus;
    const params = (r.params as Record<string, unknown>) ?? {};
    const template = templateByName(String(r.template_name));
    const iso = (v: unknown) =>
      v ? new Date(v as string).toISOString() : null;
    return {
      id: String(r.id),
      eventType: String(r.event_type),
      eventLabel: eventLabel(String(r.event_type)),
      docType: String(r.doc_type),
      docId: String(r.doc_id),
      docVersion: Number(r.doc_version),
      channel: String(r.channel),
      recipientType: String(r.recipient_type),
      recipientId: (r.recipient_id as string | null) ?? null,
      recipientName: (params.recipientName as string | undefined) || null,
      toPhoneMasked: r.to_phone_e164
        ? maskPhone(String(r.to_phone_e164))
        : null,
      templateName: String(r.template_name),
      language: String(r.language),
      status,
      reasonCode: (r.last_error as string | null) ?? null,
      reason: reasonText(r.last_error as string | null),
      attempts: Number(r.attempts ?? 0),
      scheduledFor: iso(r.scheduled_for),
      nextAttemptAt: iso(r.next_attempt_at),
      createdAt: iso(r.created_at),
      updatedAt: iso(r.updated_at),
      createdBy: (r.created_by as string | null) ?? null,
      hasMedia: Boolean(r.media_storage_key),
      preview:
        template && r.channel === 'whatsapp_api'
          ? renderPreview(template, r.language === 'ur' ? 'ur' : 'en', params)
          : null,
      canResend:
        ['failed', 'skipped', 'cancelled'].includes(status) &&
        r.channel === 'whatsapp_api',
      events,
    };
  }

  /** The PDF exactly as it was sent. */
  async media(companyId: string, messageId: string) {
    const r = rowsOf(
      await this.dataSource.query(
        `SELECT media_storage_key, doc_type, attachment FROM outbound_messages WHERE id = $1 AND company_id = $2`,
        [messageId, companyId],
      ),
    )[0];
    if (!r)
      throw new NotFoundException({
        code: 'MESSAGE_NOT_FOUND',
        message: 'Message not found',
      });
    if (!r.media_storage_key) {
      throw new NotFoundException({
        code: 'NO_MEDIA',
        message: 'No PDF was sent with this message',
      });
    }
    const file = await this.storage.read(String(r.media_storage_key));
    if (!file)
      throw new NotFoundException({
        code: 'MEDIA_MISSING',
        message: 'The stored PDF is missing',
      });
    const name = String(
      (r.attachment as { args?: { filename?: string } } | null)?.args
        ?.filename ?? `${r.doc_type}.pdf`,
    );
    return {
      file,
      filename: name.replace(/[^\w.\- ]+/g, '') || 'document.pdf',
    };
  }

  /** A new row for the same message (button: Resend). Re-checks number, consent and rules now. */
  async resend(
    companyId: string,
    messageId: string,
    userId: string,
  ): Promise<EnqueueResult> {
    const r = rowsOf(
      await this.dataSource.query(
        `SELECT * FROM outbound_messages WHERE id = $1 AND company_id = $2`,
        [messageId, companyId],
      ),
    )[0];
    if (!r)
      throw new NotFoundException({
        code: 'MESSAGE_NOT_FOUND',
        message: 'Message not found',
      });
    if (['queued', 'sending'].includes(String(r.status))) {
      throw new ConflictException({
        code: 'MESSAGE_IN_FLIGHT',
        message: 'This message is still on its way',
      });
    }
    const params = { ...((r.params as Record<string, string>) ?? {}) };
    delete params.company;
    delete params.recipientName;
    const recipient: EnqueueRecipient =
      r.recipient_type === 'user'
        ? { type: 'user', userId: String(r.recipient_id) }
        : {
            type: r.recipient_type as 'customer' | 'vendor',
            id: String(r.recipient_id),
          };
    const res = await this.messaging.enqueue(null, {
      companyId,
      event: r.event_type as MessageEventOrTest,
      docType: r.doc_type as DocType,
      docId: String(r.doc_id),
      docVersion: Number(r.doc_version),
      recipient,
      params,
      attachment: (r.attachment as EnqueueInput['attachment']) ?? null,
      createdBy: userId,
      explicit: true,
      keySuffix: `resend:${Date.now()}`,
    });
    if (!res)
      throw new BadRequestException({
        code: 'RESEND_FAILED',
        message: 'Could not queue the message',
      });
    return res;
  }

  /**
   * Someone pressed Send (an "ask each time" event, or Send reminder). One
   * message per document and event per minute, so a double click is one.
   */
  async send(
    companyId: string,
    userId: string,
    body: {
      docType: string;
      docId: string;
      event?: string;
      startDate?: string;
      endDate?: string;
    },
  ): Promise<EnqueueResult> {
    const s = await this.settings.resolve(companyId);
    const minute = new Date().toISOString().slice(0, 16);
    const keySuffix = `send:${minute}`;
    let input: EnqueueInput | null = null;
    const one = async (sql: string) =>
      rowsOf(await this.dataSource.query(sql, [body.docId, companyId]))[0] as
        | Record<string, string>
        | undefined;
    const notFound = () =>
      new NotFoundException({
        code: 'DOCUMENT_NOT_FOUND',
        message: 'Document not found',
      });

    switch (body.docType) {
      case 'invoice': {
        const inv = await one(
          `SELECT id, company_id, customer_id, invoice_number, total, balance, status,
                  to_char(due_date, 'YYYY-MM-DD') AS due_date
             FROM invoices WHERE id = $1 AND company_id = $2`,
        );
        if (!inv) throw notFound();
        if (inv.status === 'draft' || inv.status === 'void') {
          throw new BadRequestException({
            code: 'NOT_SENDABLE',
            message: `A ${inv.status} invoice cannot be sent`,
          });
        }
        const doc = {
          id: inv.id,
          companyId,
          customerId: inv.customer_id,
          invoiceNumber: inv.invoice_number,
          total: inv.total,
          balance: inv.balance,
          dueDate: inv.due_date,
        };
        const wantsReminder = !body.event || body.event.startsWith('reminder');
        if (body.event === 'invoice_issued') {
          input = {
            ...invoiceIssuedMessage(doc, userId, { whatsapp: true })!,
            keySuffix,
          };
        } else if (wantsReminder) {
          if (!toDecimal(inv.balance).greaterThan(0)) {
            throw new BadRequestException({
              code: 'NOTHING_OWED',
              message: 'Nothing is owed on this invoice',
            });
          }
          const offset = daysBetweenIso(
            inv.due_date,
            zonedToday(new Date(), s.timezone),
          );
          input = reminderMessage(
            doc,
            {
              offset,
              event: offset < 0 ? 'reminder_upcoming' : 'reminder_overdue',
            },
            {
              explicit: true,
              createdBy: userId,
              keySuffix,
            },
          );
        }
        break;
      }
      case 'payment': {
        const p = await one(
          `SELECT p.id, p.company_id, p.customer_id, p.payment_number, p.amount, c.balance
             FROM payments p JOIN customers c ON c.id = p.customer_id
            WHERE p.id = $1 AND p.company_id = $2`,
        );
        if (!p) throw notFound();
        input = {
          ...paymentReceivedMessage(
            {
              id: p.id,
              companyId,
              customerId: p.customer_id,
              paymentNumber: p.payment_number,
              amount: p.amount,
            },
            p.balance,
            userId,
          ),
          explicit: true,
          keySuffix,
        };
        break;
      }
      case 'purchase_order': {
        const po = await one(
          `SELECT id, vendor_id, po_number, total, status, to_char(expected_date, 'YYYY-MM-DD') AS expected_date
             FROM purchase_orders WHERE id = $1 AND company_id = $2`,
        );
        if (!po) throw notFound();
        if (po.status === 'draft') {
          throw new BadRequestException({
            code: 'NOT_SENDABLE',
            message: 'Approve and send the requisition first',
          });
        }
        input = {
          ...poIssuedMessage(
            {
              id: po.id,
              companyId,
              vendorId: po.vendor_id,
              poNumber: po.po_number,
              total: po.total,
              expectedDate: po.expected_date,
              status: po.status,
            },
            userId,
          ),
          explicit: true,
          keySuffix,
        };
        break;
      }
      case 'bill_payment': {
        const bp = await one(
          `SELECT id, vendor_id, total_amount, reference, to_char(payment_date, 'YYYY-MM-DD') AS payment_date
             FROM bill_payments WHERE id = $1 AND company_id = $2`,
        );
        if (!bp) throw notFound();
        const apps = rowsOf(
          await this.dataSource.query(
            `SELECT bill_id FROM bill_payment_applications WHERE bill_payment_id = $1`,
            [bp.id],
          ),
        ).map((a) => ({ billId: String(a.bill_id) }));
        const r = remittanceMessage({
          companyId,
          vendorId: bp.vendor_id,
          userId,
          payment: {
            id: bp.id,
            totalAmount: bp.total_amount,
            reference: bp.reference,
            applications: apps,
          },
          paymentDate: bp.payment_date,
        });
        input = r ? { ...r, explicit: true, keySuffix } : null;
        break;
      }
      case 'customer_statement': {
        const c = await one(
          `SELECT id FROM customers WHERE id = $1 AND company_id = $2`,
        );
        if (!c) throw notFound();
        const today = zonedToday(new Date(), s.timezone);
        const start = body.startDate?.slice(0, 10) || `${today.slice(0, 8)}01`;
        const end = body.endDate?.slice(0, 10) || today;
        const st = await this.ledger.statement(
          companyId,
          'customer',
          c.id,
          start,
          end,
        );
        input = statementMessage(
          { companyId, customerId: c.id, closingBalance: st.closingBalance },
          {
            start,
            end,
            label: `${pdfDate(start)} – ${pdfDate(end)}`,
            version: Number(end.replace(/-/g, '').slice(0, 8)),
          },
          { explicit: true, createdBy: userId, keySuffix },
        );
        break;
      }
      default:
        throw new BadRequestException({
          code: 'UNSUPPORTED_DOCUMENT',
          message: `Cannot send ${body.docType}`,
        });
    }
    if (!input)
      throw new BadRequestException({
        code: 'NOTHING_TO_SEND',
        message: 'Nothing to send for this document',
      });
    const res = await this.messaging.enqueue(null, input);
    if (!res)
      throw new BadRequestException({
        code: 'SEND_FAILED',
        message: 'Could not queue the message',
      });
    return res;
  }

  /** Log a wa.me hand-off (Connect off, or the person's own chat). */
  async manualShare(
    companyId: string,
    userId: string,
    body: { docType: string; docId: string; toPhone: string; event?: string },
  ): Promise<EnqueueResult> {
    const party = PARTY_OF[body.docType];
    if (!party)
      throw new BadRequestException({
        code: 'UNSUPPORTED_DOCUMENT',
        message: `Cannot share ${body.docType}`,
      });
    if (!toWhatsappE164(body.toPhone)) {
      throw new BadRequestException({
        code: 'INVALID_WHATSAPP_NUMBER',
        message: 'That is not a WhatsApp number',
      });
    }
    const row = rowsOf(
      await this.dataSource.query(party.sql, [body.docId, companyId]),
    )[0];
    if (!row)
      throw new NotFoundException({
        code: 'DOCUMENT_NOT_FOUND',
        message: 'Document not found',
      });
    const res = await this.messaging.logManualShare(null, {
      companyId,
      event: (body.event as MessageEventOrTest) || party.event,
      docType: body.docType as DocType,
      docId: body.docId,
      recipient: { type: party.type, id: String(row.party) },
      toPhone: body.toPhone,
      createdBy: userId,
    });
    if (!res)
      throw new BadRequestException({
        code: 'LOG_FAILED',
        message: 'Could not record the share',
      });
    return res;
  }

  /** Delivery and collections figures for [from, to]. */
  async stats(companyId: string, from?: string, to?: string) {
    const s = await this.settings.resolve(companyId);
    const today = zonedToday(new Date(), s.timezone);
    const end = (to || today).slice(0, 10);
    const start = (from || `${end.slice(0, 8)}01`).slice(0, 10);
    const range = [companyId, start, end];
    const counts = rowsOf(
      await this.dataSource.query(
        `SELECT
            COUNT(*) FILTER (WHERE status IN ('sent','delivered','read')) AS sent,
            COUNT(*) FILTER (WHERE status IN ('delivered','read')) AS delivered,
            COUNT(*) FILTER (WHERE status = 'read') AS read,
            COUNT(*) FILTER (WHERE status = 'failed') AS failed,
            COUNT(*) FILTER (WHERE status = 'skipped') AS skipped,
            COUNT(*) FILTER (WHERE status IN ('queued','sending')) AS queued,
            COUNT(*) FILTER (WHERE event_type IN ('reminder_upcoming','reminder_overdue')
                             AND status IN ('sent','delivered','read')) AS reminders_sent
           FROM outbound_messages
          WHERE company_id = $1 AND channel = 'whatsapp_api'
            AND created_at >= $2::date AND created_at < ($3::date + 1)`,
        range,
      ),
    )[0];
    const paid = rowsOf(
      await this.dataSource.query(
        `SELECT COUNT(DISTINCT m.doc_id) AS n
           FROM outbound_messages m
           JOIN invoices i ON i.id = m.doc_id AND i.company_id = m.company_id
          WHERE m.company_id = $1 AND m.doc_type = 'invoice'
            AND m.event_type IN ('reminder_upcoming','reminder_overdue')
            AND m.status IN ('sent','delivered','read')
            AND m.created_at >= $2::date AND m.created_at < ($3::date + 1)
            AND i.status = 'paid'
            AND EXISTS (
              SELECT 1 FROM payment_applications pa
              JOIN payments p ON p.id = pa.payment_id
             WHERE pa.invoice_id = i.id
               AND p.payment_date >= m.created_at::date
               AND p.payment_date <= (m.created_at + interval '7 days')::date)`,
        range,
      ),
    )[0];
    const recent = rowsOf(
      await this.dataSource.query(
        `SELECT m.id, m.doc_id, m.event_type, m.status, m.last_error, m.to_phone_e164, m.created_at,
                i.invoice_number, i.status AS invoice_status, i.balance, c.name AS customer_name
           FROM outbound_messages m
           JOIN invoices i ON i.id = m.doc_id AND i.company_id = m.company_id
           LEFT JOIN customers c ON c.id = i.customer_id
          WHERE m.company_id = $1 AND m.doc_type = 'invoice'
            AND m.event_type IN ('reminder_upcoming','reminder_overdue')
          ORDER BY m.created_at DESC
          LIMIT 50`,
        [companyId],
      ),
    );
    const dsoAt = async (asOf: string | null) => {
      if (!asOf) return null;
      try {
        const k = await this.kpis.healthKpi(companyId, 'dso', asOf);
        return k.value === null ? null : Math.round(k.value * 10) / 10;
      } catch {
        return null;
      }
    };
    const enabledOn = s.enabledAt
      ? zonedToday(new Date(s.enabledAt), s.timezone)
      : null;
    const period = zonedPeriod(new Date(), s.timezone);
    const usage = rowsOf(
      await this.dataSource.query(
        `SELECT COALESCE(SUM(count), 0) AS n FROM messaging_usage WHERE company_id = $1 AND period = $2`,
        [companyId, period],
      ),
    )[0];
    const n = (v: unknown) => Number(v ?? 0);
    return {
      from: start,
      to: end,
      sent: n(counts?.sent),
      delivered: n(counts?.delivered),
      read: n(counts?.read),
      failed: n(counts?.failed),
      skipped: n(counts?.skipped),
      queued: n(counts?.queued),
      remindersSent: n(counts?.reminders_sent),
      invoicesPaidWithin7DaysOfReminder: n(paid?.n),
      dso: {
        period: await dsoAt(end),
        beforeConnect: await dsoAt(enabledOn),
        enabledAt: s.enabledAt ? new Date(s.enabledAt).toISOString() : null,
      },
      usage: { period, count: n(usage?.n), cap: s.monthlyCap },
      recentReminders: recent.map((r) => {
        const outcome =
          r.invoice_status === 'paid'
            ? 'paid'
            : r.invoice_status === 'void'
              ? 'void'
              : new Decimal(String(r.balance ?? 0)).greaterThan(0)
                ? 'open'
                : 'paid';
        return {
          messageId: String(r.id),
          invoiceId: String(r.doc_id),
          invoiceNumber: String(r.invoice_number),
          customerName: (r.customer_name as string | null) ?? '',
          eventType: String(r.event_type),
          status: String(r.status),
          reason: reasonText(r.last_error as string | null),
          toPhoneMasked: r.to_phone_e164
            ? maskPhone(String(r.to_phone_e164))
            : null,
          sentAt: new Date(r.created_at as string).toISOString(),
          balance: formatRupees(String(r.balance ?? 0)),
          outcome,
        };
      }),
    };
  }

  /** Contacts that cannot be messaged (or one contact's status, with partyType + partyId). */
  async contactHealth(
    companyId: string,
    filter: { partyType?: string; partyId?: string } = {},
  ) {
    const s = await this.settings.resolve(companyId);
    const consentAll = Boolean(s.contactsOptInConfirmedAt);
    const single = filter.partyType && filter.partyId;
    const read = async (table: 'customers' | 'vendors', nameCol: string) =>
      rowsOf(
        await this.dataSource.query(
          `SELECT t.id, t.code, ${nameCol} AS name, t.phone, t.whatsapp_e164, t.whatsapp_opt_out,
                  t.whatsapp_opt_in_at, t.whatsapp_verified_at,
                  EXISTS (
                    SELECT 1 FROM outbound_messages m
                     WHERE m.company_id = t.company_id AND m.recipient_id = t.id
                       AND m.to_phone_e164 = t.whatsapp_e164 AND m.status = 'failed'
                       AND m.last_error ILIKE '%cannot receive WhatsApp%'
                       AND (t.whatsapp_verified_at IS NULL OR m.updated_at > t.whatsapp_verified_at)
                  ) AS undeliverable
             FROM ${table} t
            WHERE t.company_id = $1 AND t.is_active = true ${single ? 'AND t.id = $2' : ''}
            ORDER BY ${nameCol}`,
          single ? [companyId, filter.partyId] : [companyId],
        ),
      );
    const classify = (
      partyType: 'customer' | 'vendor',
      r: Record<string, unknown>,
    ): ContactHealthRow => {
      const status: ContactHealthRow['status'] = r.whatsapp_opt_out
        ? 'opted_out'
        : !r.whatsapp_e164
          ? r.phone && String(r.phone).trim()
            ? 'invalid'
            : 'missing'
          : r.undeliverable
            ? 'not_on_whatsapp'
            : !r.whatsapp_opt_in_at && !consentAll
              ? 'no_consent'
              : r.whatsapp_verified_at
                ? 'ready'
                : 'unverified';
      return {
        partyType,
        id: String(r.id),
        code: (r.code as string | null) ?? null,
        name: String(r.name ?? ''),
        phone: (r.phone as string | null) ?? null,
        whatsappE164: (r.whatsapp_e164 as string | null) ?? null,
        status,
        optInAt: r.whatsapp_opt_in_at
          ? new Date(r.whatsapp_opt_in_at as string).toISOString()
          : null,
        verifiedAt: r.whatsapp_verified_at
          ? new Date(r.whatsapp_verified_at as string).toISOString()
          : null,
      };
    };
    const customers =
      !single || filter.partyType === 'customer'
        ? (await read('customers', 't.name')).map((r) =>
            classify('customer', r),
          )
        : [];
    const vendors =
      !single || filter.partyType === 'vendor'
        ? (await read('vendors', 't.company_name')).map((r) =>
            classify('vendor', r),
          )
        : [];
    const all = [...customers, ...vendors];
    const summary = {
      total: all.length,
      ready: all.filter((c) => c.status === 'ready').length,
      unverified: all.filter((c) => c.status === 'unverified').length,
      noConsent: all.filter((c) => c.status === 'no_consent').length,
      missing: all.filter((c) => c.status === 'missing').length,
      invalid: all.filter((c) => c.status === 'invalid').length,
      notOnWhatsapp: all.filter((c) => c.status === 'not_on_whatsapp').length,
      optedOut: all.filter((c) => c.status === 'opted_out').length,
    };
    if (single) return { summary, contacts: all };
    // The fix list: everyone who is not plainly ready (unverified included: a
    // number nobody has delivered to yet is worth a look).
    return { summary, contacts: all.filter((c) => c.status !== 'ready') };
  }

  /** settings test: fm_test to the caller's own number. */
  async sendTest(companyId: string, userId: string): Promise<EnqueueResult> {
    const u = rowsOf(
      await this.dataSource.query(`SELECT phone FROM users WHERE id = $1`, [
        userId,
      ]),
    )[0];
    if (!toWhatsappE164(u?.phone as string | null)) {
      throw new BadRequestException({
        code: 'NO_PHONE',
        message:
          'Add your mobile number to your profile first; the test goes to you.',
      });
    }
    const res = await this.messaging.enqueue(null, {
      companyId,
      event: 'test',
      docType: 'test',
      docId: randomUUID(),
      recipient: { type: 'user', userId },
      createdBy: userId,
      explicit: true,
    });
    if (!res)
      throw new BadRequestException({
        code: 'SEND_FAILED',
        message: 'Could not queue the test message',
      });
    return res;
  }
}
