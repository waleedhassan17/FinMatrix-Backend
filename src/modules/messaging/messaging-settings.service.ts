import { BadRequestException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource, EntityManager } from 'typeorm';
import { businessTimezone } from '../../common/utils/business-date.util';
import { CompanyMessagingSettings } from './entities/company-messaging-settings.entity';
import {
  DEFAULT_EVENT_RULES,
  DEFAULT_QUIET_HOURS,
  DEFAULT_REMINDER_SCHEDULE,
  EVENT_RULES,
  EventRule,
  EventRules,
  MESSAGE_EVENTS,
  MessageEvent,
  MessageLanguage,
  QuietHours,
  ReminderSchedule,
} from './messaging.constants';
import {
  decryptToken,
  encryptToken,
  maskToken,
  messagingKey,
} from './token-crypto.util';
import { sendingAvailable, whatsappLive } from './messaging-env.util';
import { getPlanConfig, whatsappAllowance } from '../billing/plan-config';
import { zonedPeriod } from './quiet-hours.util';

/** A company's Connect settings with every default filled in. */
export interface ResolvedMessagingSettings {
  companyId: string;
  /** False when there is no settings row yet. */
  exists: boolean;
  enabled: boolean;
  enabledAt: Date | null;
  senderMode: 'shared' | 'own';
  phoneNumberId: string | null;
  wabaId: string | null;
  accessTokenEnc: string | null;
  defaultLanguage: MessageLanguage;
  eventRules: EventRules;
  quietHours: QuietHours | null;
  reminderSchedule: ReminderSchedule;
  monthlyCap: number | null;
  contactsOptInConfirmedAt: Date | null;
  contactsOptInConfirmedBy: string | null;
  /** IANA zone the company works in (Asia/Karachi when unset). */
  timezone: string;
  companyName: string;
  /**
   * WhatsApp messages a month FinMatrix sends for this company (its plan's
   * allowance; decision D35). Separate from the owner's own monthlyCap.
   */
  planAllowance: number;
  updatedAt: Date | null;
}

export interface UpdateMessagingSettingsInput {
  enabled?: boolean;
  senderMode?: 'shared' | 'own';
  phoneNumberId?: string | null;
  wabaId?: string | null;
  /** Write-only. '' or null clears it. */
  accessToken?: string | null;
  defaultLanguage?: MessageLanguage;
  eventRules?: Partial<Record<string, string>>;
  quietHours?: QuietHours | null;
  reminderSchedule?: ReminderSchedule;
  monthlyCap?: number | null;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Reads and writes company_messaging_settings. Lives in MessagingCoreModule
 * because enqueue() needs it inside the posting transaction (same manager).
 */
@Injectable()
export class MessagingSettingsService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly config: ConfigService,
  ) {}

  async resolve(
    companyId: string,
    manager?: EntityManager,
  ): Promise<ResolvedMessagingSettings> {
    const m = manager ?? this.dataSource.manager;
    const rows: Array<Record<string, unknown>> = await m.query(
      `SELECT c.name AS company_name, c.subscription_plan AS subscription_plan, cs.timezone AS timezone, s.*
         FROM companies c
         LEFT JOIN company_settings cs ON cs.company_id = c.id
         LEFT JOIN company_messaging_settings s ON s.company_id = c.id
        WHERE c.id = $1
        LIMIT 1`,
      [companyId],
    );
    const r = rows[0] ?? {};
    const exists = r.company_id !== null && r.company_id !== undefined;
    const storedRules =
      (r.event_rules as Partial<Record<string, string>> | null) ?? {};
    return {
      companyId,
      exists,
      enabled: exists ? Boolean(r.enabled) : false,
      enabledAt: (r.enabled_at as Date | null) ?? null,
      senderMode: (r.sender_mode as 'shared' | 'own') ?? 'shared',
      phoneNumberId: (r.phone_number_id as string | null) ?? null,
      wabaId: (r.waba_id as string | null) ?? null,
      accessTokenEnc: (r.access_token_enc as string | null) ?? null,
      defaultLanguage: (r.default_language as MessageLanguage) ?? 'en',
      eventRules: mergeRules(storedRules),
      quietHours: exists
        ? ((r.quiet_hours as QuietHours | null) ?? null)
        : DEFAULT_QUIET_HOURS,
      reminderSchedule: normaliseSchedule(
        r.reminder_schedule as ReminderSchedule | null,
      ),
      monthlyCap:
        r.monthly_cap === null || r.monthly_cap === undefined
          ? null
          : Number(r.monthly_cap),
      contactsOptInConfirmedAt:
        (r.contacts_opt_in_confirmed_at as Date | null) ?? null,
      contactsOptInConfirmedBy:
        (r.contacts_opt_in_confirmed_by as string | null) ?? null,
      timezone: businessTimezone(r.timezone as string | null),
      companyName: (r.company_name as string) ?? '',
      planAllowance: whatsappAllowance(
        getPlanConfig(r.subscription_plan as string | null),
      ),
      updatedAt: (r.updated_at as Date | null) ?? null,
    };
  }

  /**
   * Template messages sent this month that count against the limits: every
   * category except 'service' (plain-text replies, free up to Meta's tier).
   */
  async usedThisPeriod(
    companyId: string,
    period: string,
    manager?: EntityManager,
  ): Promise<number> {
    const m = manager ?? this.dataSource.manager;
    const rows: Array<Record<string, unknown>> = await m.query(
      `SELECT COALESCE(SUM(count), 0) AS used FROM messaging_usage
        WHERE company_id = $1 AND period = $2 AND category <> 'service'`,
      [companyId, period],
    );
    return Number(rows[0]?.used ?? 0);
  }

  /** The plan allowance and this month's use, for the settings screens. */
  async allowance(
    s: ResolvedMessagingSettings,
  ): Promise<{ limit: number; used: number; period: string }> {
    const period = zonedPeriod(new Date(), s.timezone);
    return {
      limit: s.planAllowance,
      used: await this.usedThisPeriod(s.companyId, period),
      period,
    };
  }

  /** The API view: never the token, only whether one is set and its last four. */
  view(s: ResolvedMessagingSettings) {
    const token = decryptToken(s.accessTokenEnc, this.key());
    return {
      enabled: s.enabled,
      enabledAt: s.enabledAt,
      senderMode: s.senderMode,
      phoneNumberId: s.phoneNumberId,
      wabaId: s.wabaId,
      accessTokenSet: Boolean(s.accessTokenEnc),
      accessTokenMasked: maskToken(token),
      defaultLanguage: s.defaultLanguage,
      eventRules: s.eventRules,
      quietHours: s.quietHours,
      reminderSchedule: s.reminderSchedule,
      monthlyCap: s.monthlyCap,
      contactsOptInConfirmedAt: s.contactsOptInConfirmedAt,
      timezone: s.timezone,
      providerMode: whatsappLive(this.config) ? 'live' : 'simulated',
      /** False on a production server that cannot send yet (Connect cannot be switched on). */
      available: sendingAvailable(this.config),
      updatedAt: s.updatedAt,
    };
  }

  async update(
    companyId: string,
    input: UpdateMessagingSettingsInput,
  ): Promise<ResolvedMessagingSettings> {
    const current = await this.resolve(companyId);
    const patch: Partial<CompanyMessagingSettings> = {};

    if (input.enabled !== undefined) {
      if (input.enabled && !sendingAvailable(this.config)) {
        throw new BadRequestException({
          code: 'WHATSAPP_NOT_READY',
          message:
            'WhatsApp sending is still being set up, so it cannot be switched on yet.',
        });
      }
      patch.enabled = Boolean(input.enabled);
      if (patch.enabled && !current.enabledAt) patch.enabledAt = new Date();
    }
    if (input.senderMode !== undefined) {
      if (!['shared', 'own'].includes(input.senderMode))
        throw bad('senderMode must be shared or own');
      patch.senderMode = input.senderMode;
    }
    if (input.phoneNumberId !== undefined)
      patch.phoneNumberId = blankToNull(input.phoneNumberId);
    if (input.wabaId !== undefined) patch.wabaId = blankToNull(input.wabaId);
    if (input.accessToken !== undefined) {
      const token = blankToNull(input.accessToken);
      if (token === null) {
        patch.accessTokenEnc = null;
      } else {
        const key = this.key();
        if (!key) {
          throw new BadRequestException({
            code: 'MESSAGING_KEY_MISSING',
            message:
              'The server cannot store an access token yet: MESSAGING_ENCRYPTION_KEY is not set.',
          });
        }
        patch.accessTokenEnc = encryptToken(token, key);
      }
    }
    if (input.defaultLanguage !== undefined) {
      if (!['en', 'ur'].includes(input.defaultLanguage))
        throw bad('defaultLanguage must be en or ur');
      patch.defaultLanguage = input.defaultLanguage;
    }
    if (input.eventRules !== undefined) {
      const next: Partial<EventRules> = { ...current.eventRules };
      for (const [event, rule] of Object.entries(input.eventRules ?? {})) {
        if (!(MESSAGE_EVENTS as readonly string[]).includes(event))
          throw bad(`Unknown event ${event}`);
        if (!(EVENT_RULES as readonly string[]).includes(String(rule))) {
          throw bad(`Rule for ${event} must be auto, manual or off`);
        }
        next[event as MessageEvent] = rule as EventRule;
      }
      patch.eventRules = next;
    }
    if (input.quietHours !== undefined) {
      if (input.quietHours === null) {
        patch.quietHours = null;
      } else {
        if (
          !HHMM.test(input.quietHours.start ?? '') ||
          !HHMM.test(input.quietHours.end ?? '')
        ) {
          throw bad('Quiet hours are HH:mm, for example 21:00 and 09:00');
        }
        patch.quietHours = {
          start: input.quietHours.start,
          end: input.quietHours.end,
        };
      }
    }
    if (input.reminderSchedule !== undefined) {
      const days = (v: unknown) =>
        Array.isArray(v) &&
        v.every((d) => Number.isInteger(d) && d >= 0 && d <= 365) &&
        v.length <= 10;
      if (
        !days(input.reminderSchedule?.beforeDue) ||
        !days(input.reminderSchedule?.afterDue)
      ) {
        throw bad(
          'Reminder days are whole numbers from 0 to 365 (at most 10 of each)',
        );
      }
      patch.reminderSchedule = {
        beforeDue: uniqSorted(
          input.reminderSchedule.beforeDue.filter((d) => d > 0),
        ),
        afterDue: uniqSorted(input.reminderSchedule.afterDue),
      };
    }
    if (input.monthlyCap !== undefined) {
      if (
        input.monthlyCap !== null &&
        (!Number.isInteger(input.monthlyCap) || input.monthlyCap < 0)
      ) {
        throw bad('The monthly cap is a whole number, or empty for no cap');
      }
      patch.monthlyCap = input.monthlyCap;
    }

    await this.upsert(companyId, patch);
    if (input.quietHours !== undefined) {
      // Messages held for the old window are looked at again under the new one.
      await this.dataSource.query(
        `UPDATE outbound_messages SET scheduled_for = NULL, last_error = NULL, updated_at = now()
          WHERE company_id = $1 AND status = 'queued' AND last_error = 'quiet_hours'`,
        [companyId],
      );
    }
    return this.resolve(companyId);
  }

  async confirmContactsConsent(
    companyId: string,
    userId: string,
  ): Promise<ResolvedMessagingSettings> {
    const current = await this.resolve(companyId);
    if (current.contactsOptInConfirmedAt) return current; // once
    await this.upsert(companyId, {
      contactsOptInConfirmedAt: new Date(),
      contactsOptInConfirmedBy: userId,
    });
    return this.resolve(companyId);
  }

  /** The company's own token, decrypted, for sender_mode 'own'. */
  ownAccessToken(s: ResolvedMessagingSettings): string | null {
    return decryptToken(s.accessTokenEnc, this.key());
  }

  private async upsert(
    companyId: string,
    patch: Partial<CompanyMessagingSettings>,
  ) {
    const repo = this.dataSource.getRepository(CompanyMessagingSettings);
    const existing = await repo.findOne({ where: { companyId } });
    if (existing) {
      await repo.save({ ...existing, ...patch, companyId });
    } else {
      await repo.save(
        repo.create({
          companyId,
          enabled: false,
          senderMode: 'shared',
          defaultLanguage: 'en',
          eventRules: { ...DEFAULT_EVENT_RULES },
          quietHours: { ...DEFAULT_QUIET_HOURS },
          reminderSchedule: { ...DEFAULT_REMINDER_SCHEDULE },
          ...patch,
        }),
      );
    }
  }

  private key(): Buffer | null {
    return messagingKey(
      this.config.get<string>('MESSAGING_ENCRYPTION_KEY') ??
        process.env.MESSAGING_ENCRYPTION_KEY,
    );
  }
}

export function mergeRules(
  stored: Partial<Record<string, string>>,
): EventRules {
  const out = { ...DEFAULT_EVENT_RULES };
  for (const e of MESSAGE_EVENTS) {
    const r = stored?.[e];
    if (r && (EVENT_RULES as readonly string[]).includes(r))
      out[e] = r as EventRule;
  }
  return out;
}

function normaliseSchedule(
  s: ReminderSchedule | null | undefined,
): ReminderSchedule {
  const ok = (v: unknown): v is number[] =>
    Array.isArray(v) && v.every((d) => Number.isInteger(d));
  return {
    beforeDue: ok(s?.beforeDue)
      ? s!.beforeDue
      : DEFAULT_REMINDER_SCHEDULE.beforeDue,
    afterDue: ok(s?.afterDue)
      ? s!.afterDue
      : DEFAULT_REMINDER_SCHEDULE.afterDue,
  };
}

function uniqSorted(v: number[]): number[] {
  return [...new Set(v)].sort((a, b) => a - b);
}

function blankToNull(v: string | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t === '' ? null : t;
}

function bad(message: string) {
  return new BadRequestException({
    code: 'INVALID_MESSAGING_SETTINGS',
    message,
  });
}
