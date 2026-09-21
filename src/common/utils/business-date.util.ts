/**
 * The calendar date a business is actually living in.
 *
 * Postings used to be dated with `new Date().toISOString().slice(0, 10)`, which
 * is the UTC calendar day. Every FinMatrix company trades in Pakistan (UTC+5),
 * so anything recorded between midnight and 05:00 local time was dated
 * YESTERDAY: a goods receipt at 01:30 on the 16th landed on the 15th, fell
 * outside a "today" report, and could even slip into a period the owner had
 * already closed. The clients already use the device's local day; the server
 * has to agree with them.
 *
 * Resolution order: an explicit IANA zone (a company's own setting) when it is
 * a real zone and not the 'UTC' placeholder new companies were created with,
 * then BUSINESS_TIMEZONE from the environment, then Asia/Karachi.
 */
const DEFAULT_BUSINESS_TIMEZONE = 'Asia/Karachi';

const validZones = new Map<string, boolean>();

function isValidTimeZone(zone: string): boolean {
  const cached = validZones.get(zone);
  if (cached !== undefined) return cached;
  let valid = true;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: zone });
  } catch {
    valid = false;
  }
  validZones.set(zone, valid);
  return valid;
}

export function businessTimezone(preferred?: string | null): string {
  const zone = (preferred ?? '').trim();
  if (zone && zone.toUpperCase() !== 'UTC' && isValidTimeZone(zone)) return zone;
  const fromEnv = (process.env.BUSINESS_TIMEZONE ?? '').trim();
  if (fromEnv && isValidTimeZone(fromEnv)) return fromEnv;
  return DEFAULT_BUSINESS_TIMEZONE;
}

/** `YYYY-MM-DD` for `now` in the business time zone. */
export function businessToday(preferred?: string | null, now: Date = new Date()): string {
  // en-CA formats a date as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: businessTimezone(preferred),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Calendar arithmetic on an ISO date, free of any time zone. */
export function addDaysIso(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Whole calendar days from `fromIso` to `toIso`, free of any time zone.
 * Positive when `toIso` is the later date.
 *
 * Both ends are snapped to UTC midnight before subtracting, so the result is a
 * count of calendar days and never a fraction rounded by the local clock. The
 * aging report used to do this as
 * `Math.floor((new Date() - new Date(dueDate)) / 86400000)`, which compares a
 * date-only column parsed as UTC midnight against a local wall-clock instant:
 * in Asia/Karachi that reads up to 5 hours short and can land a document a
 * whole day out. Invisible at 30-day buckets, a whole bucket at 3-day ones.
 */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  const [fy, fm, fd] = fromIso.slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = toIso.slice(0, 10).split('-').map(Number);
  return Math.round(
    (Date.UTC(ty, tm - 1, td) - Date.UTC(fy, fm - 1, fd)) / 86_400_000,
  );
}

/**
 * Days of credit a vendor or customer payment-terms code grants. The stored
 * codes are `net30`-style (types/index.ts PaymentTerms); the underscored
 * spellings the clients use are accepted too.
 */
export const PAYMENT_TERMS_DAYS: Record<string, number> = {
  due_on_receipt: 0,
  net15: 15,
  net30: 30,
  net45: 45,
  net60: 60,
  '2_10_net30': 30,
  net_15: 15,
  net_30: 30,
  net_45: 45,
  net_60: 60,
};

export function termsDays(terms: string | null | undefined, fallback = 30): number {
  if (!terms) return fallback;
  const days = PAYMENT_TERMS_DAYS[terms];
  return days === undefined ? fallback : days;
}
