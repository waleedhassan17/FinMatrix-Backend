/**
 * FinMatrix Connect vocabulary. The contract the app and the web build against
 * (CONNECT_API_CONTRACT.md) uses exactly these strings.
 */

export const MESSAGE_EVENTS = [
  'invoice_issued',
  'invoice_revised',
  'invoice_cancelled',
  'payment_received',
  'po_issued',
  'po_cancelled',
  'remittance',
  'approval_pending',
  'reminder_upcoming',
  'reminder_overdue',
  'statement',
  'delivery_update',
] as const;
export type MessageEvent = (typeof MESSAGE_EVENTS)[number];

/** `test` is the settings screen's "send me a test" — never a rule. */
export type MessageEventOrTest = MessageEvent | 'test';

export const EVENT_RULES = ['auto', 'manual', 'off'] as const;
export type EventRule = (typeof EVENT_RULES)[number];
export type EventRules = Record<MessageEvent, EventRule>;

/** Must match the column default in 1790500000000-MessagingFoundation. */
export const DEFAULT_EVENT_RULES: EventRules = {
  invoice_issued: 'auto',
  invoice_revised: 'auto',
  invoice_cancelled: 'auto',
  payment_received: 'auto',
  po_issued: 'auto',
  po_cancelled: 'auto',
  remittance: 'auto',
  approval_pending: 'auto',
  reminder_upcoming: 'auto',
  reminder_overdue: 'auto',
  statement: 'off',
  delivery_update: 'off',
};

export const MESSAGE_STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'read',
  'failed',
  'skipped',
  'cancelled',
] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/** Why a message was written as 'skipped' instead of 'queued'. */
export const SKIP_REASONS = [
  'feature_off',
  'connect_disabled',
  'rule_off',
  'rule_manual',
  'no_number',
  'opted_out',
  'no_consent',
  'cap_reached',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export const DOC_TYPES = [
  'invoice',
  'payment',
  'purchase_order',
  'bill_payment',
  'bill_settlement',
  'customer_statement',
  'approval_request',
  'delivery',
  'test',
] as const;
export type DocType = (typeof DOC_TYPES)[number];

export type RecipientType = 'customer' | 'vendor' | 'user';
export type MessageChannel = 'whatsapp_api' | 'wa_link';
export type MessageLanguage = 'en' | 'ur';

export interface QuietHours {
  start: string; // 'HH:mm' company time
  end: string;
}
export interface ReminderSchedule {
  beforeDue: number[]; // days before the due date
  afterDue: number[]; // days after (0 = on the due date)
}

export const DEFAULT_QUIET_HOURS: QuietHours = { start: '21:00', end: '09:00' };
export const DEFAULT_REMINDER_SCHEDULE: ReminderSchedule = {
  beforeDue: [3],
  afterDue: [0, 7, 15, 30],
};

/** Reminder events: cancelled when the invoice is paid. */
export const REMINDER_EVENTS: MessageEvent[] = [
  'reminder_upcoming',
  'reminder_overdue',
];

/** Events that go out at any hour (an owner waiting to approve). */
export const QUIET_HOURS_EXEMPT: MessageEventOrTest[] = [
  'approval_pending',
  'test',
];

/** Status order for webhook updates: only ever move forward. */
export const STATUS_RANK: Record<MessageStatus, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  // Terminal states sit outside the delivery ladder; see applyStatus.
  failed: 10,
  skipped: 10,
  cancelled: 10,
};

/** Statuses that mean the recipient was actually sent the document. */
export const SENT_STATUSES: MessageStatus[] = ['sent', 'delivered', 'read'];

export const MAX_SEND_ATTEMPTS = 6;
export const STUCK_SENDING_MINUTES = 10;
export const DISPATCH_BATCH = 20;
