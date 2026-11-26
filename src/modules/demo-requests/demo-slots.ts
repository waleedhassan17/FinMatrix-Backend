import { createHmac, timingSafeEqual } from 'crypto';
import {
  demoSlotDayEnd,
  demoSlotDayStart,
  demoSlotDaysAhead,
  demoSlotMinutes,
  demoSlotWeekdays,
} from '../../config/launch.settings';

/** Pakistan Standard Time is UTC+5 all year (no daylight saving). */
const PKT_OFFSET_MIN = 5 * 60;
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

/** Midnight PKT of the day `d` falls on, as a UTC instant. */
function pktMidnight(d: Date): number {
  const shifted = d.getTime() + PKT_OFFSET_MIN * MIN;
  return Math.floor(shifted / DAY) * DAY - PKT_OFFSET_MIN * MIN;
}

/** ISO weekday (1 = Monday … 7 = Sunday) of a PKT midnight instant. */
function pktWeekday(midnightUtc: number): number {
  const wd = new Date(midnightUtc + PKT_OFFSET_MIN * MIN).getUTCDay(); // 0=Sun
  return wd === 0 ? 7 : wd;
}

/**
 * Every bookable slot start between tomorrow and DEMO_SLOT_DAYS_AHEAD days
 * out, as UTC instants, on the configured weekdays and hours (PKT).
 * Today is never offered: someone has to see the request and prepare.
 */
export function allSlots(now: Date = new Date()): Date[] {
  const out: Date[] = [];
  const first = pktMidnight(now) + DAY;
  const days = demoSlotDaysAhead();
  const start = demoSlotDayStart();
  const end = demoSlotDayEnd();
  const len = demoSlotMinutes();
  const weekdays = new Set(demoSlotWeekdays());
  for (let i = 0; i < days; i++) {
    const midnight = first + i * DAY;
    if (!weekdays.has(pktWeekday(midnight))) continue;
    for (let m = start; m + len <= end; m += len) {
      out.push(new Date(midnight + m * MIN));
    }
  }
  return out;
}

/** True when `at` is exactly one of the bookable slot starts. */
export function isBookableSlot(at: Date, now: Date = new Date()): boolean {
  const t = at.getTime();
  return allSlots(now).some((s) => s.getTime() === t);
}

/** "2026-12-03" in PKT, for grouping slots by day on the client. */
export function pktDate(at: Date): string {
  return new Date(at.getTime() + PKT_OFFSET_MIN * MIN)
    .toISOString()
    .slice(0, 10);
}

/** "10:30" in PKT. */
export function pktTime(at: Date): string {
  return new Date(at.getTime() + PKT_OFFSET_MIN * MIN)
    .toISOString()
    .slice(11, 16);
}

// ── Form token: minimum fill time without trusting the client's clock ──────

const MIN_FILL_MS = 3_000;
const MAX_FORM_AGE_MS = 6 * 60 * MIN;

function formKey(): string {
  return `${process.env.JWT_SECRET ?? 'finmatrix'}:demo-form`;
}

/** A signed "this form was handed out at" token, issued with the slots. */
export function issueFormToken(now: number = Date.now()): string {
  const issued = String(now);
  const sig = createHmac('sha256', formKey())
    .update(issued)
    .digest('base64url');
  return `${issued}.${sig}`;
}

/**
 * 'ok' | 'too_fast' (filled in under 3 s — a bot) | 'invalid' (missing,
 * forged or older than 6 hours).
 */
export function checkFormToken(
  token: string | undefined,
  now: number = Date.now(),
): 'ok' | 'too_fast' | 'invalid' {
  const [issued, sig] = String(token ?? '').split('.');
  if (!issued || !sig || !/^\d+$/.test(issued)) return 'invalid';
  const expected = createHmac('sha256', formKey())
    .update(issued)
    .digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return 'invalid';
  const age = now - Number(issued);
  if (age < 0 || age > MAX_FORM_AGE_MS) return 'invalid';
  if (age < MIN_FILL_MS) return 'too_fast';
  return 'ok';
}
