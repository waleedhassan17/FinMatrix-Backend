import { QuietHours } from './messaging.constants';

/**
 * Wall-clock parts of `instant` in `timeZone` (Intl, no tz library).
 */
export function zonedParts(instant: Date, timeZone: string) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const p: Record<string, number> = {};
  for (const part of fmt.formatToParts(instant)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return {
    year: p.year,
    month: p.month,
    day: p.day,
    hour: p.hour,
    minute: p.minute,
    second: p.second,
  };
}

/** Offset (ms) of `timeZone` from UTC at `instant`: local = utc + offset. */
function offsetMs(instant: Date, timeZone: string): number {
  const z = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    z.year,
    z.month - 1,
    z.day,
    z.hour,
    z.minute,
    z.second,
  );
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * The UTC instant of local wall-clock `y-m-d hh:mm` in `timeZone`. Two passes
 * so an offset change on that day (DST) is picked up; Asia/Karachi has none.
 */
export function zonedTimeToUtc(
  y: number,
  m: number,
  d: number,
  hh: number,
  mm: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  let utc = guess - offsetMs(new Date(guess), timeZone);
  utc = guess - offsetMs(new Date(utc), timeZone);
  return new Date(utc);
}

function toMinutes(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((hhmm ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * When a message due `now` must wait for: null when `now` is outside the quiet
 * window, else the window's end (company time) as a UTC instant.
 *
 * The window may cross midnight (21:00 → 09:00 is the default): at 23:30 the
 * end is tomorrow 09:00; at 02:00 it is today 09:00. start === end means no
 * quiet hours. A malformed window means no quiet hours (never hold a message
 * forever on bad settings).
 */
export function deferUntil(
  now: Date,
  timeZone: string,
  window: QuietHours | null | undefined,
): Date | null {
  if (!window) return null;
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  if (start === null || end === null || start === end) return null;

  const z = zonedParts(now, timeZone);
  const cur = z.hour * 60 + z.minute;
  const crossesMidnight = start > end;
  const inside = crossesMidnight
    ? cur >= start || cur < end
    : cur >= start && cur < end;
  if (!inside) return null;

  // End falls tomorrow when we are in the evening half of a midnight-crossing
  // window; otherwise it is later today.
  const endIsTomorrow = crossesMidnight && cur >= start;
  const base = new Date(
    Date.UTC(z.year, z.month - 1, z.day + (endIsTomorrow ? 1 : 0)),
  );
  return zonedTimeToUtc(
    base.getUTCFullYear(),
    base.getUTCMonth() + 1,
    base.getUTCDate(),
    Math.floor(end / 60),
    end % 60,
    timeZone,
  );
}

/** `YYYY-MM` of `instant` in `timeZone` (messaging_usage.period). */
export function zonedPeriod(instant: Date, timeZone: string): string {
  const z = zonedParts(instant, timeZone);
  return `${z.year}-${String(z.month).padStart(2, '0')}`;
}
