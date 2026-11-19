import { addDaysIso } from '../../common/utils/business-date.util';
import { zonedParts, zonedTimeToUtc } from '../messaging/quiet-hours.util';
import { DayFigure, DayKpi } from './day-summary.types';

/** A real calendar date in `YYYY-MM-DD` form — not merely the right shape. */
export function isIsoDate(v: unknown): v is string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

/**
 * The UTC instants a local calendar day starts and ends at: [start, end).
 * Comparing `created_at` with these keeps the (company_id, created_at) index
 * usable, which `CAST(created_at AT TIME ZONE tz AS date)` would not.
 */
export function localDayBounds(
  isoDate: string,
  timeZone: string,
): { start: Date; end: Date } {
  const [y, m, d] = isoDate.split('-').map(Number);
  const [ny, nm, nd] = addDaysIso(isoDate, 1).split('-').map(Number);
  return {
    start: zonedTimeToUtc(y, m, d, 0, 0, timeZone),
    end: zonedTimeToUtc(ny, nm, nd, 0, 0, timeZone),
  };
}

/** The local calendar date of `instant` in `timeZone`, `YYYY-MM-DD`. */
export function localIsoDate(instant: Date, timeZone: string): string {
  const z = zonedParts(instant, timeZone);
  return `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;
}

/**
 * Which day an end-of-day digest due at local `hour` should cover at `now`,
 * or null when it is not due yet.
 *
 * From noon the digest covers that same day ("tonight at 9 PM: today").
 * Before noon it is a morning recap of the day before ("8 AM: yesterday"), so
 * an owner who wants the numbers with breakfast gets a complete day. Once the
 * hour has passed it stays due for the rest of the local day, so a server that
 * was down at the hour still sends when it comes back.
 */
export function digestDayDue(
  now: Date,
  timeZone: string,
  hour: number,
): string | null {
  const z = zonedParts(now, timeZone);
  if (z.hour < hour) return null;
  const today = localIsoDate(now, timeZone);
  return hour < 12 ? addDaysIso(today, -1) : today;
}

/** The 8 dates a summary reads: the week before `date` through `date`. */
export function summaryWindow(date: string): {
  from: string;
  previousDay: string;
  sameDayLastWeek: string;
  trendDates: string[];
} {
  return {
    from: addDaysIso(date, -7),
    previousDay: addDaysIso(date, -1),
    sameDayLastWeek: addDaysIso(date, -7),
    trendDates: [6, 5, 4, 3, 2, 1, 0].map((n) => addDaysIso(date, -n)),
  };
}

export const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const num = (v: unknown) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '0'));
  return Number.isFinite(n) ? n : 0;
};

/** A per-date series → the headline figure for `date` with its comparisons. */
export function buildKpi(byDate: Map<string, DayFigure>, date: string): DayKpi {
  const w = summaryWindow(date);
  const at = (d: string): DayFigure => {
    const f = byDate.get(d);
    return { count: f?.count ?? 0, total: r2(f?.total ?? 0) };
  };
  return {
    ...at(date),
    previousDay: at(w.previousDay),
    sameDayLastWeek: at(w.sameDayLastWeek),
    trend: w.trendDates.map((d) => at(d).total),
  };
}

/** "Rs 245,000" — the digest's money format (no decimals for whole rupees). */
export function digestMoney(currency: string, amount: number): string {
  const prefix = currency === 'PKR' || !currency ? 'Rs' : currency;
  const rounded = r2(amount);
  const whole = Number.isInteger(rounded);
  return `${prefix} ${rounded.toLocaleString('en-US', {
    minimumFractionDigits: whole ? 0 : 2,
    maximumFractionDigits: 2,
  })}`;
}

/** "Thu 19 Nov 2026" for an ISO date, free of any time zone. */
export function longDayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const part = (o: Intl.DateTimeFormatOptions) =>
    dt.toLocaleDateString('en-GB', { ...o, timeZone: 'UTC' });
  return `${part({ weekday: 'short' })} ${d} ${part({ month: 'short' })} ${y}`;
}
