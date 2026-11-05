import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DataSource, EntityManager } from 'typeorm';
import { companyFeatures } from '../../common/features/company-features.util';
import { maskPhone, toWhatsappE164 } from '../../common/utils/phone.util';
import {
  MessagingSettingsService,
  ResolvedMessagingSettings,
} from './messaging-settings.service';
import { MessageAttachment } from './entities/outbound-message.entity';
import {
  AUTO_REPLY_EVENT,
  DocType,
  MessageEventOrTest,
  MessageLanguage,
  MessageStatus,
  RecipientType,
  SENT_STATUSES,
  SkipReason,
  TEXT_MESSAGE_TEMPLATE,
} from './messaging.constants';
import { templateForEvent } from './templates/template-registry';
import { zonedPeriod } from './quiet-hours.util';

export type EnqueueRecipient =
  | { type: 'customer'; id: string }
  | { type: 'vendor'; id: string }
  | { type: 'user'; userId: string };

export interface EnqueueInput {
  companyId: string;
  event: MessageEventOrTest;
  docType: DocType;
  docId: string;
  /** Distinguishes sends of the same document (revision, reminder offset, month). Default 1. */
  docVersion?: number;
  recipient: EnqueueRecipient;
  /** Template values by name (see template-registry). company / recipientName are added here. */
  params?: Record<string, string | number | null | undefined>;
  attachment?: MessageAttachment | null;
  createdBy?: string | null;
  scheduledFor?: Date | null;
  /** Someone pressed Send: a 'manual' rule does not hold it back. 'off' still does. */
  explicit?: boolean;
  /**
   * Same idempotency key as a row still 'queued' in this transaction: replace
   * its params/attachment instead of doing nothing (settle()'s covering
   * remittance, decision D2).
   */
  mergeIntoQueued?: boolean;
  /**
   * Only write a row if the recipient was actually sent something about this
   * document before (decision D3: no "cancelled" for a document they never got).
   */
  requireSent?: { docType: DocType; docId: string; events?: string[] };
  /** Appended to the idempotency key (resend). */
  keySuffix?: string;
  /**
   * docVersion = 1 + the rows this event already has for the document, so a
   * second real occurrence (a PO sent, withdrawn and sent again) is a new
   * message while a retried call inside the same lock still dedupes.
   */
  autoVersion?: boolean;
  /** Template values looked up here so the hook in the service stays one call. */
  lookups?: {
    billNumbers?: { param: string; ids: string[] };
    userName?: { param: string; userId: string };
  };
}

export interface EnqueueResult {
  id: string;
  status: MessageStatus;
  skipReason: SkipReason | null;
  /** The key already existed; nothing new was written. */
  duplicate: boolean;
}

export interface LastMessageStatus {
  messageId: string;
  status: MessageStatus;
  eventType: string;
  channel: string;
  updatedAt: string;
  lastError: string | null;
}

interface RecipientRow {
  name: string;
  phone: string | null;
  optedOut: boolean;
  consented: boolean;
  language: MessageLanguage | null;
}

/**
 * The one call accounting code makes into Connect.
 *
 * enqueue() writes ONE row — 'queued', or 'skipped' with the reason — with the
 * caller's EntityManager, so it commits or rolls back with the posting that
 * caused it. It never talks to Meta and NEVER throws: its work runs inside a
 * SAVEPOINT, so even a failing SQL statement is rolled back to the savepoint
 * and cannot abort the caller's transaction. A failure is logged (phone
 * masked) and null is returned; the posting carries on.
 */
@Injectable()
export class MessagingService {
  private readonly logger = new Logger(MessagingService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly settings: MessagingSettingsService,
  ) {}

  async enqueue(
    manager: EntityManager | null | undefined,
    input: EnqueueInput | null | undefined,
  ): Promise<EnqueueResult | null> {
    if (!input) return null; // the event sends nothing (see document-messages.ts)
    const m = manager ?? this.dataSource.manager;
    return this.guarded(
      m,
      `enqueue ${input.event} ${input.docType}:${input.docId}`,
      () => this.doEnqueue(m, input),
    );
  }

  /**
   * Record a document someone shared by hand through a wa.me link (Connect
   * off, or the person chose their own chat). channel 'wa_link', status
   * 'sent', no provider call — it exists so the timeline is complete and a
   * later cancellation knows the party had the document. Returns null when
   * the number is not a WhatsApp number. Never throws.
   */
  async logManualShare(
    manager: EntityManager | null | undefined,
    input: {
      companyId: string;
      event: MessageEventOrTest;
      docType: DocType;
      docId: string;
      recipient: EnqueueRecipient;
      toPhone: string | null | undefined;
      createdBy?: string | null;
    },
  ): Promise<EnqueueResult | null> {
    const phone = toWhatsappE164(input.toPhone ?? null);
    if (!phone) return null;
    const m = manager ?? this.dataSource.manager;
    return this.guarded(
      m,
      `manual share ${input.docType}:${input.docId}`,
      async () => {
        const template = templateForEvent(input.event);
        const rows = rowsOf(
          await m.query(
            `INSERT INTO outbound_messages
             (company_id, event_type, doc_type, doc_id, doc_version, recipient_type, recipient_id,
              to_phone_e164, channel, template_name, language, params, status, attempts,
              idempotency_key, created_by)
           VALUES ($1, $2, $3, $4, 1, $5, $6, $7, 'wa_link', $8, 'en', '{}'::jsonb, 'sent', 1,
                   $9, $10)
           RETURNING id, status`,
            [
              input.companyId,
              input.event,
              input.docType,
              input.docId,
              input.recipient.type,
              input.recipient.type === 'user'
                ? input.recipient.userId
                : input.recipient.id,
              phone,
              template.name,
              `manual:${input.docType}:${input.docId}:${randomUUID()}`,
              input.createdBy ?? null,
            ],
          ),
        );
        const id = String(rows[0].id);
        await m.query(
          `INSERT INTO message_status_events (message_id, status, occurred_at, raw)
         VALUES ($1, 'sent', now(), '{"channel":"wa_link"}'::jsonb)`,
          [id],
        );
        return {
          id,
          status: 'sent' as MessageStatus,
          skipReason: null,
          duplicate: false,
        };
      },
    );
  }

  /**
   * Answer a customer or vendor who wrote to the FinMatrix number: one
   * plain-text row (event 'auto_reply'), filed under the document they were
   * last sent so it shows in that document's WhatsApp history. At most one a
   * day per company and number (idempotency key). Only written while the
   * company has Connect on. Never throws; null when nothing was written.
   */
  async enqueueAutoReply(input: {
    companyId: string;
    docType: string;
    docId: string;
    recipient: { type: 'customer' | 'vendor'; id: string };
    toPhone: string;
    language: MessageLanguage;
    text: string;
    day: string;
  }): Promise<EnqueueResult | null> {
    const m = this.dataSource.manager;
    return this.guarded(
      m,
      `auto-reply ${input.docType}:${input.docId}`,
      async () => {
        const features = await companyFeatures(m, input.companyId);
        const s = await this.settings.resolve(input.companyId, m);
        if (!features.whatsappConnect || !s.enabled) return null;
        const key = [
          AUTO_REPLY_EVENT,
          input.companyId,
          input.toPhone,
          input.day,
        ].join(':');
        const rows = rowsOf(
          await m.query(
            `INSERT INTO outbound_messages
             (company_id, event_type, doc_type, doc_id, doc_version, recipient_type, recipient_id,
              to_phone_e164, channel, template_name, language, params, status, idempotency_key)
           VALUES ($1, $2, $3, $4, 1, $5, $6, $7, 'whatsapp_api', $8, $9, $10::jsonb, 'queued', $11)
           ON CONFLICT (idempotency_key) DO NOTHING
           RETURNING id, status`,
            [
              input.companyId,
              AUTO_REPLY_EVENT,
              input.docType,
              input.docId,
              input.recipient.type,
              input.recipient.id,
              input.toPhone,
              TEXT_MESSAGE_TEMPLATE,
              input.language,
              JSON.stringify({ company: s.companyName, text: input.text }),
              key,
            ],
          ),
        );
        if (rows.length === 0) {
          return {
            id: '',
            status: 'queued' as MessageStatus,
            skipReason: null,
            duplicate: true,
          };
        }
        this.logger.log(
          `auto-reply ${input.docType}:${input.docId} -> ${maskPhone(input.toPhone)} queued`,
        );
        return {
          id: String(rows[0].id),
          status: rows[0].status as MessageStatus,
          skipReason: null,
          duplicate: false,
        };
      },
    );
  }

  /**
   * One message per ACTIVE admin (owner) of the company — the approval alert.
   * Never throws; returns the rows written.
   */
  async enqueueForAdmins(
    manager: EntityManager | null | undefined,
    input: Omit<EnqueueInput, 'recipient'>,
  ): Promise<EnqueueResult[]> {
    const m = manager ?? this.dataSource.manager;
    const admins =
      (await this.guarded(m, `admins of ${input.companyId}`, async () =>
        rowsOf(
          await m.query(
            `SELECT uc.user_id FROM user_companies uc
               JOIN users u ON u.id = uc.user_id
              WHERE uc.company_id = $1 AND uc.role = 'admin' AND u.is_active = true
              ORDER BY uc.joined_at`,
            [input.companyId],
          ),
        ).map((r) => String(r.user_id)),
      )) ?? [];
    const out: EnqueueResult[] = [];
    for (const userId of admins) {
      const r = await this.enqueue(m, {
        ...input,
        recipient: { type: 'user', userId },
      });
      if (r) out.push(r);
    }
    return out;
  }

  /**
   * Queued (not yet sent) rows for these documents -> 'cancelled'. With
   * `events`, only those events (a payment cancels reminders, nothing else).
   * Never throws; returns how many rows were cancelled.
   */
  async cancelQueued(
    manager: EntityManager | null | undefined,
    companyId: string,
    docType: DocType,
    docIds: string | string[],
    opts: { events?: string[]; reason?: string } = {},
  ): Promise<number> {
    const ids = (Array.isArray(docIds) ? docIds : [docIds]).filter(Boolean);
    if (ids.length === 0) return 0;
    const m = manager ?? this.dataSource.manager;
    const n = await this.guarded(m, `cancelQueued ${docType}`, async () => {
      const params: unknown[] = [
        companyId,
        docType,
        ids,
        opts.reason ?? 'document_changed',
      ];
      let sql = `UPDATE outbound_messages
                    SET status = 'cancelled', last_error = $4, updated_at = now()
                  WHERE company_id = $1 AND doc_type = $2 AND doc_id = ANY($3::uuid[])
                    AND status = 'queued'`;
      if (opts.events?.length) {
        params.push(opts.events);
        sql += ` AND event_type = ANY($5::text[])`;
      }
      const res: unknown = await m.query(sql + ' RETURNING id', params);
      return rowsOf(res).length;
    });
    return n ?? 0;
  }

  /** The newest message per document, for list ticks. One query for the whole page. */
  async lastStatusFor(
    companyId: string,
    docType: DocType,
    docIds: string[],
  ): Promise<Map<string, LastMessageStatus>> {
    const out = new Map<string, LastMessageStatus>();
    const ids = [
      ...new Set(
        docIds.filter((id) => typeof id === 'string' && UUID.test(id)),
      ),
    ];
    if (ids.length === 0) return out;
    try {
      const rows: Array<Record<string, unknown>> = await this.dataSource.query(
        `SELECT DISTINCT ON (doc_id) doc_id, id, status, event_type, channel, updated_at, last_error
           FROM outbound_messages
          WHERE company_id = $1 AND doc_type = $2 AND doc_id = ANY($3::uuid[])
            AND event_type <> 'auto_reply'
          ORDER BY doc_id, created_at DESC, id DESC`,
        [companyId, docType, ids],
      );
      for (const r of rows) {
        out.set(String(r.doc_id), {
          messageId: String(r.id),
          status: r.status as MessageStatus,
          eventType: String(r.event_type),
          channel: String(r.channel),
          updatedAt: new Date(r.updated_at as string).toISOString(),
          lastError: (r.last_error as string | null) ?? null,
        });
      }
    } catch (err) {
      this.logger.warn(`lastStatusFor failed: ${(err as Error).message}`);
    }
    return out;
  }

  /**
   * Adds `lastMessageStatus` to a response: an entity, an array of them, or
   * a list envelope ({ data: [...] } or { data: { data: [...] } }). Used by
   * controllers so accounting services' read methods stay untouched (D7).
   */
  async withLastStatus<T>(
    companyId: string,
    docType: DocType,
    payload: T,
    idKey = 'id',
  ): Promise<T> {
    const items = listItems(payload);
    if (items.length === 0) return payload;
    const map = await this.lastStatusFor(
      companyId,
      docType,
      items.map((i) => String(i[idKey] ?? '')),
    );
    for (const item of items)
      item.lastMessageStatus = map.get(String(item[idKey] ?? '')) ?? null;
    return payload;
  }

  // ───────────────────────────────────────────────────────────────────────

  private async doEnqueue(
    m: EntityManager,
    input: EnqueueInput,
  ): Promise<EnqueueResult | null> {
    if (input.requireSent) {
      const params: unknown[] = [
        input.companyId,
        input.requireSent.docType,
        input.requireSent.docId,
        SENT_STATUSES,
      ];
      let sql = `SELECT 1 FROM outbound_messages
                  WHERE company_id = $1 AND doc_type = $2 AND doc_id = $3 AND status = ANY($4::text[])`;
      if (input.requireSent.events?.length) {
        params.push(input.requireSent.events);
        sql += ` AND event_type = ANY($5::text[])`;
      }
      const prior = rowsOf(await m.query(sql + ' LIMIT 1', params));
      if (prior.length === 0) return null; // they never got the original: say nothing
    }

    const template = templateForEvent(input.event);
    const looked = await this.resolveLookups(m, input);
    const settings = await this.settings.resolve(input.companyId, m);
    const recipient = await this.loadRecipient(
      m,
      input.companyId,
      input.recipient,
    );
    const toPhone = recipient?.phone ?? null;

    const skip = await this.skipReason(m, input, settings, recipient);
    const language: MessageLanguage =
      recipient?.language ?? settings.defaultLanguage ?? 'en';
    const params = {
      ...stringParams(input.params),
      ...looked,
      company: settings.companyName,
      recipientName: recipient?.name ?? '',
    };
    let version = input.docVersion ?? 1;
    if (input.autoVersion) {
      const prior = rowsOf(
        await m.query(
          `SELECT COUNT(*)::int AS n FROM outbound_messages
            WHERE company_id = $1 AND event_type = $2 AND doc_type = $3 AND doc_id = $4
              AND channel = 'whatsapp_api' AND idempotency_key NOT LIKE '%:resend:%'`,
          [input.companyId, input.event, input.docType, input.docId],
        ),
      );
      version = Number(prior[0]?.n ?? 0) + 1;
    }
    const key = [
      input.event,
      input.docType,
      input.docId,
      version,
      toPhone ?? 'none',
    ]
      .concat(input.keySuffix ? [input.keySuffix] : [])
      .join(':');

    const conflict = input.mergeIntoQueued
      ? `ON CONFLICT (idempotency_key) DO UPDATE
           SET params = EXCLUDED.params, attachment = EXCLUDED.attachment, updated_at = now()
         WHERE outbound_messages.status = 'queued'`
      : 'ON CONFLICT (idempotency_key) DO NOTHING';

    const inserted = rowsOf(
      await m.query(
        `INSERT INTO outbound_messages
           (company_id, event_type, doc_type, doc_id, doc_version, recipient_type, recipient_id,
            to_phone_e164, channel, template_name, language, params, attachment, status,
            last_error, idempotency_key, scheduled_for, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'whatsapp_api', $9, $10, $11::jsonb, $12::jsonb,
                 $13, $14, $15, $16, $17)
         ${conflict}
         RETURNING id, status, last_error`,
        [
          input.companyId,
          input.event,
          input.docType,
          input.docId,
          version,
          input.recipient.type as RecipientType,
          input.recipient.type === 'user'
            ? input.recipient.userId
            : input.recipient.id,
          toPhone,
          template.name,
          language,
          JSON.stringify(params),
          input.attachment ? JSON.stringify(input.attachment) : null,
          skip ? 'skipped' : 'queued',
          skip,
          key,
          input.scheduledFor ?? null,
          input.createdBy ?? null,
        ],
      ),
    );

    if (inserted.length > 0) {
      const r = inserted[0];
      this.logger.log(
        `${input.event} ${input.docType}:${input.docId} -> ${maskPhone(toPhone)} ${String(r.status)}${skip ? ` (${skip})` : ''}`,
      );
      return {
        id: String(r.id),
        status: r.status as MessageStatus,
        skipReason: skip,
        duplicate: false,
      };
    }
    const existing = rowsOf(
      await m.query(
        `SELECT id, status, last_error FROM outbound_messages WHERE idempotency_key = $1`,
        [key],
      ),
    );
    if (existing.length === 0) return null;
    return {
      id: String(existing[0].id),
      status: existing[0].status as MessageStatus,
      skipReason: (existing[0].last_error as SkipReason | null) ?? null,
      duplicate: true,
    };
  }

  private async resolveLookups(
    m: EntityManager,
    input: EnqueueInput,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const bills = input.lookups?.billNumbers;
    if (bills) {
      const ids = bills.ids.filter((id) => UUID.test(id));
      const nums = ids.length
        ? rowsOf(
            await m.query(
              `SELECT bill_number FROM bills WHERE company_id = $1 AND id = ANY($2::uuid[]) ORDER BY bill_number`,
              [input.companyId, ids],
            ),
          )
            .map((r) => String(r.bill_number ?? ''))
            .filter(Boolean)
        : [];
      out[bills.param] =
        nums.length === 0
          ? ids.length === 1
            ? '1 bill'
            : `${ids.length} bills`
          : nums.length > 3
            ? `${nums.slice(0, 3).join(', ')} and ${nums.length - 3} more`
            : nums.join(', ');
    }
    const user = input.lookups?.userName;
    if (user) {
      const r = rowsOf(
        await m.query(
          `SELECT display_name, username, email FROM users WHERE id = $1 LIMIT 1`,
          [user.userId],
        ),
      )[0];
      out[user.param] = String(
        r?.display_name || r?.username || r?.email || 'A team member',
      );
    }
    return out;
  }

  private async skipReason(
    m: EntityManager,
    input: EnqueueInput,
    s: ResolvedMessagingSettings,
    recipient: RecipientRow | null,
  ): Promise<SkipReason | null> {
    const features = await companyFeatures(m, input.companyId);
    if (!features.whatsappConnect) return 'feature_off';
    const isTest = input.event === 'test';
    if (!s.enabled && !isTest) return 'connect_disabled';
    if (!isTest) {
      const rule =
        s.eventRules[input.event as keyof typeof s.eventRules] ?? 'off';
      if (rule === 'off') return 'rule_off';
      if (rule === 'manual' && !input.explicit) return 'rule_manual';
    }
    if (!recipient?.phone) return 'no_number';
    if (recipient.optedOut) return 'opted_out';
    if (
      input.recipient.type !== 'user' &&
      !recipient.consented &&
      !s.contactsOptInConfirmedAt
    ) {
      return 'no_consent';
    }
    const planLimit =
      typeof s.planAllowance === 'number' ? s.planAllowance : null;
    if ((s.monthlyCap !== null || planLimit !== null) && !isTest) {
      // Sent this month (templates only; free 'service' replies excluded)
      // plus what is already waiting to go.
      const usedRows = rowsOf(
        await m.query(
          `SELECT COALESCE((SELECT SUM(count) FROM messaging_usage
                             WHERE company_id = $1 AND period = $2 AND category <> 'service'), 0)
                + (SELECT COUNT(*) FROM outbound_messages
                    WHERE company_id = $1 AND channel = 'whatsapp_api' AND status IN ('queued','sending')
                      AND event_type NOT IN ('test','auto_reply')) AS used`,
          [input.companyId, zonedPeriod(new Date(), s.timezone)],
        ),
      );
      const used = Number(usedRows[0]?.used ?? 0);
      if (s.monthlyCap !== null && used >= s.monthlyCap) return 'cap_reached';
      if (planLimit !== null && used >= planLimit) return 'plan_limit_reached';
    }
    return null;
  }

  private async loadRecipient(
    m: EntityManager,
    companyId: string,
    recipient: EnqueueRecipient,
  ): Promise<RecipientRow | null> {
    if (recipient.type === 'user') {
      const rows = rowsOf(
        await m.query(
          `SELECT u.display_name AS name, u.phone AS phone
             FROM users u
             JOIN user_companies uc ON uc.user_id = u.id AND uc.company_id = $2
            WHERE u.id = $1 AND u.is_active = true
            LIMIT 1`,
          [recipient.userId, companyId],
        ),
      );
      if (!rows[0]) return null;
      return {
        name: String(rows[0].name ?? ''),
        phone: toWhatsappE164(rows[0].phone as string | null),
        optedOut: false,
        consented: true,
        language: null,
      };
    }
    const isVendor = recipient.type === 'vendor';
    const rows = rowsOf(
      await m.query(
        isVendor
          ? `SELECT company_name AS name, contact_person, whatsapp_e164, whatsapp_opt_out,
                    whatsapp_opt_in_at, preferred_language
               FROM vendors WHERE id = $1 AND company_id = $2 LIMIT 1`
          : `SELECT name, contact_person, whatsapp_e164, whatsapp_opt_out,
                    whatsapp_opt_in_at, preferred_language
               FROM customers WHERE id = $1 AND company_id = $2 LIMIT 1`,
        [recipient.id, companyId],
      ),
    );
    const r = rows[0];
    if (!r) return null;
    const contact = (r.contact_person as string | null)?.trim();
    return {
      // Vendors are greeted by their contact person; customers by name.
      name: isVendor ? contact || String(r.name ?? '') : String(r.name ?? ''),
      phone: (r.whatsapp_e164 as string | null) ?? null,
      optedOut: Boolean(r.whatsapp_opt_out),
      consented: Boolean(r.whatsapp_opt_in_at),
      language: (r.preferred_language as MessageLanguage | null) ?? null,
    };
  }

  /**
   * Run `fn` so that nothing it does can break the caller: inside the
   * caller's transaction it gets a SAVEPOINT (a failed statement would
   * otherwise abort the whole posting), and any error becomes null.
   */
  private async guarded<T>(
    m: EntityManager,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T | null> {
    const inTx = Boolean(m.queryRunner?.isTransactionActive);
    try {
      if (inTx) await m.query('SAVEPOINT fm_messaging');
      const out = await fn();
      if (inTx) await m.query('RELEASE SAVEPOINT fm_messaging');
      return out;
    } catch (err) {
      if (inTx) {
        try {
          await m.query('ROLLBACK TO SAVEPOINT fm_messaging');
          await m.query('RELEASE SAVEPOINT fm_messaging');
        } catch {
          /* the savepoint itself failed; the caller's own error handling decides */
        }
      }
      this.logger.error(
        `${label} failed (nothing sent, posting unaffected): ${maskDigits((err as Error).message)}`,
      );
      return null;
    }
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function stringParams(p: EnqueueInput['params']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(p ?? {}))
    out[k] = v === null || v === undefined ? '' : String(v);
  return out;
}

/** manager.query returns rows, or [rows, count] for UPDATE ... RETURNING. */
function rowsOf(res: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(res)) return [];
  if (res.length === 2 && Array.isArray(res[0]) && typeof res[1] === 'number') {
    return res[0] as Array<Record<string, unknown>>;
  }
  return res as Array<Record<string, unknown>>;
}

/** Never let a phone number reach the logs through an error message. */
function maskDigits(s: string): string {
  return (s ?? '').replace(/\+?\d{9,15}/g, (d) =>
    maskPhone(d.startsWith('+') ? d : `+${d}`),
  );
}

function listItems(payload: unknown): Array<Record<string, unknown>> {
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload))
    return payload.filter((x) => x && typeof x === 'object');
  const p = payload as Record<string, unknown>;
  if (Array.isArray(p.data)) return listItems(p.data);
  if (
    p.data &&
    typeof p.data === 'object' &&
    Array.isArray((p.data as Record<string, unknown>).data)
  ) {
    return listItems((p.data as Record<string, unknown>).data);
  }
  if (typeof p.id === 'string') return [p];
  return [];
}

export { rowsOf };
