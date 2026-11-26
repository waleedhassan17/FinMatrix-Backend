import { parseBoolean } from '../common/utils/env.util';

// ═══════════════════════════════════════════════════════
// Launch settings — sign-up paths, free trial, demo booking, support contacts
// ═══════════════════════════════════════════════════════
// One reader for every launch switch, evaluated AT CALL TIME rather than at
// import. plan-config.ts (the trial length) is imported before ConfigModule has
// loaded .env, so a constant computed at import would silently ignore a
// TRIAL_DAYS set in .env. env.validation.ts validates the same keys at boot;
// the parsing here only has to be tolerant, never strict.

export type SignupMode = 'trial' | 'approval';

export const DEFAULT_TRIAL_DAYS = 30;
export const DEFAULT_TRIAL_REMINDER_DAYS = [7, 3, 1] as const;

function int(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function list(raw: string | undefined): string[] {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** `trial` offers both paths; `approval` offers path B (request approval) only. */
export function signupMode(): SignupMode {
  return String(process.env.SIGNUP_MODE ?? '')
    .trim()
    .toLowerCase() === 'approval'
    ? 'approval'
    : 'trial';
}

/** false sends every trial request to the admin queue (the abuse switch). */
export function trialAutoApprove(): boolean {
  return parseBoolean(process.env.TRIAL_AUTO_APPROVE) ?? true;
}

/** Length of the free trial, counted from the moment it is granted. */
export function trialDays(): number {
  const n = int(process.env.TRIAL_DAYS, DEFAULT_TRIAL_DAYS);
  return n >= 1 && n <= 90 ? n : DEFAULT_TRIAL_DAYS;
}

/**
 * Days-left thresholds for the trial-ending reminder (email + in-app), largest
 * first. Each is sent once per trial period.
 */
export function trialReminderDays(): number[] {
  const parsed = list(process.env.TRIAL_REMINDER_DAYS)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n >= 1 && n <= 60);
  const days = parsed.length ? parsed : [...DEFAULT_TRIAL_REMINDER_DAYS];
  return [...new Set(days)].sort((a, b) => b - a);
}

/** More start-trial attempts than this from one IP in 24 h holds the request. */
export function trialRiskMaxIpAttempts(): number {
  return Math.max(1, int(process.env.TRIAL_RISK_MAX_IP_ATTEMPTS_24H, 3));
}

/** Extra blocked email domains, on top of the bundled disposable list. */
export function trialBlockedEmailDomains(): string[] {
  return list(process.env.TRIAL_BLOCKED_EMAIL_DOMAINS).map((d) =>
    d.toLowerCase().replace(/^@/, ''),
  );
}

export function demoBookingEnabled(): boolean {
  return parseBoolean(process.env.DEMO_BOOKING_ENABLED) ?? true;
}

/** The support inbox shown to customers. Falls back to the platform admin inbox. */
export function supportEmail(): string {
  return (
    (process.env.SUPPORT_EMAIL ?? '').trim() ||
    (process.env.ADMIN_EMAIL ?? '').trim() ||
    (process.env.SUPER_ADMIN_EMAIL ?? '').trim()
  );
}

/** WhatsApp number shown to customers, E.164 or empty. */
export function supportWhatsapp(): string {
  return (process.env.SUPPORT_WHATSAPP ?? '').trim();
}

/** The customer web app, without a trailing slash (links in emails). */
export function webAppUrl(): string {
  return (
    process.env.WEB_APP_URL ?? 'https://finmatrix-theta.vercel.app'
  ).replace(/\/+$/, '');
}

/** Public Cloudflare Turnstile site key, or empty when Turnstile is off. */
export function turnstileSiteKey(): string {
  return (process.env.TURNSTILE_SITE_KEY ?? '').trim();
}

/** Days an untouched draft migration batch is kept before the cleanup sweep. */
export function migrationDraftRetentionDays(): number {
  return Math.max(1, int(process.env.MIGRATION_DRAFT_RETENTION_DAYS, 30));
}

/** Days a deleted company's final backup stays downloadable by super-admins. */
export function deletionBackupRetentionDays(): number {
  return Math.max(1, int(process.env.DELETION_BACKUP_RETENTION_DAYS, 30));
}

// ── Demo booking slots (Asia/Karachi) ──────────────────────────────────────

/** How many days ahead a prospect may book (today excluded). */
export function demoSlotDaysAhead(): number {
  return Math.min(Math.max(int(process.env.DEMO_SLOT_DAYS_AHEAD, 14), 1), 60);
}

/** "HH:MM" → minutes after midnight, or the fallback. */
function hhmm(raw: string | undefined, fallback: number): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(raw ?? '').trim());
  if (!m) return fallback;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 24 * 60 ? v : fallback;
}

/** First slot start, minutes after midnight PKT (default 10:00). */
export function demoSlotDayStart(): number {
  return hhmm(process.env.DEMO_SLOT_DAY_START, 10 * 60);
}

/** End of the booking day, minutes after midnight PKT (default 18:00). */
export function demoSlotDayEnd(): number {
  return hhmm(process.env.DEMO_SLOT_DAY_END, 18 * 60);
}

/** Length of one slot in minutes (default 30). */
export function demoSlotMinutes(): number {
  return Math.min(Math.max(int(process.env.DEMO_SLOT_MINUTES, 30), 15), 120);
}

/** Bookable ISO weekdays (1 = Monday … 7 = Sunday), default Mon–Sat. */
export function demoSlotWeekdays(): number[] {
  const days = list(process.env.DEMO_SLOT_WEEKDAYS)
    .map((d) => Number.parseInt(d, 10))
    .filter((d) => d >= 1 && d <= 7);
  return days.length ? [...new Set(days)] : [1, 2, 3, 4, 5, 6];
}

/** Demos that may share one slot (default 1). */
export function demoSlotCapacity(): number {
  return Math.min(Math.max(int(process.env.DEMO_SLOT_CAPACITY, 1), 1), 20);
}

/** Cloudflare Turnstile secret; empty = Turnstile not checked. */
export function turnstileSecret(): string {
  return (process.env.TURNSTILE_SECRET ?? '').trim();
}

/** What GET /public/config returns: everything a client needs, nothing secret. */
export function publicLaunchConfig() {
  return {
    signupMode: signupMode(),
    trialAutoApprove: trialAutoApprove(),
    trialDays: trialDays(),
    demoBookingEnabled: demoBookingEnabled(),
    supportEmail: supportEmail(),
    supportWhatsapp: supportWhatsapp(),
    turnstileSiteKey: turnstileSiteKey(),
  };
}
