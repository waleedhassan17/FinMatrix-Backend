import { asciiDigits } from './text-normalize';

export type DateOrder = 'dmy' | 'mdy';

export type DateResult =
  | { ok: true; iso: string | null }
  | { ok: false; error: string }
  /** Both readings are valid dates and nothing says which; the caller asks. */
  | { ok: false; ambiguous: true; dmy: string; mdy: string };

const MONTHS: Record<string, number> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

/** Excel's day 1 is 1900-01-01, with the 1900 leap-year bug; 25569 = 1970-01-01. */
const EXCEL_EPOCH_MS = Date.UTC(1899, 11, 30);
const SERIAL_MIN = 20_000; // 1954
const SERIAL_MAX = 80_000; // 2119

const pad = (n: number) => String(n).padStart(2, '0');

function validYmd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  )
    return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

function fullYear(y: number): number {
  return y < 100 ? (y < 70 ? 2000 + y : 1900 + y) : y;
}

/**
 * A date as a file carries it, to ISO `YYYY-MM-DD` — or the reason it is not
 * one, or the two readings it could be.
 *
 *   2026-11-12  12/11/2026  12-11-2026  12.11.2026  12-Nov-2026  Nov 12, 2026
 *   12/11/26    2026/11/12  46003 (Excel serial)   a Date cell from exceljs
 *
 * `order` says how to read `a/b/yyyy` when both a and b fit a month. Without
 * it such a value is reported ambiguous rather than guessed: 03/04/2026 is
 * 3 April in Pakistan and 4 March in the US, and a wrong guess silently
 * moves a due date by a month.
 */
export function parseDate(input: unknown, order?: DateOrder): DateResult {
  if (input === null || input === undefined) return { ok: true, iso: null };
  if (input instanceof Date) {
    if (Number.isNaN(input.getTime()))
      return { ok: false, error: 'is not a date.' };
    return { ok: true, iso: input.toISOString().slice(0, 10) };
  }
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < SERIAL_MIN || input > SERIAL_MAX)
      return { ok: false, error: `${input} is not a date.` };
    const ms = EXCEL_EPOCH_MS + Math.floor(input) * 86_400_000;
    return { ok: true, iso: new Date(ms).toISOString().slice(0, 10) };
  }
  if (typeof input !== 'string') return { ok: false, error: 'is not a date.' };

  const text = asciiDigits(input.trim());
  if (text === '') return { ok: true, iso: null };

  // ISO, with or without a time part.
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(text);
  if (m) {
    const iso = validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso
      ? { ok: true, iso }
      : { ok: false, error: `"${input}" is not a real date.` };
  }
  // 12-Nov-2026, 12 Nov 2026, 12-November-26
  m = /^(\d{1,2})[-/ .]([A-Za-z]{3,9})[-/ .,]+(\d{2}|\d{4})$/.exec(text);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    if (!mon) return { ok: false, error: `"${input}" has an unknown month.` };
    const iso = validYmd(fullYear(Number(m[3])), mon, Number(m[1]));
    return iso
      ? { ok: true, iso }
      : { ok: false, error: `"${input}" is not a real date.` };
  }
  // Nov 12, 2026 / November 12 2026
  m = /^([A-Za-z]{3,9})[ .-]+(\d{1,2}),?[ .-]+(\d{2}|\d{4})$/.exec(text);
  if (m) {
    const mon = MONTHS[m[1].toLowerCase()];
    if (!mon) return { ok: false, error: `"${input}" has an unknown month.` };
    const iso = validYmd(fullYear(Number(m[3])), mon, Number(m[2]));
    return iso
      ? { ok: true, iso }
      : { ok: false, error: `"${input}" is not a real date.` };
  }
  // a/b/yyyy — day-first or month-first.
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(text);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(Number(m[3]));
    const dmy = validYmd(y, b, a);
    const mdy = validYmd(y, a, b);
    if (order === 'dmy')
      return dmy
        ? { ok: true, iso: dmy }
        : {
            ok: false,
            error: `"${input}" is not a real date (day/month/year).`,
          };
    if (order === 'mdy')
      return mdy
        ? { ok: true, iso: mdy }
        : {
            ok: false,
            error: `"${input}" is not a real date (month/day/year).`,
          };
    if (dmy && mdy && dmy !== mdy)
      return { ok: false, ambiguous: true, dmy, mdy };
    const only = dmy ?? mdy;
    return only
      ? { ok: true, iso: only }
      : { ok: false, error: `"${input}" is not a real date.` };
  }
  // A serial typed as text.
  if (/^\d{5}$/.test(text)) return parseDate(Number(text), order);
  return { ok: false, error: `"${input}" is not a date.` };
}

/**
 * What a whole column of dates tells us about its order. One value with a
 * first part over 12 settles it as day-first; one with a second part over 12
 * as month-first; a column where EVERY value fits both ways is ambiguous and
 * the owner is asked (AMBIGUOUS_DATE_FORMAT), never guessed.
 */
export function detectDateOrder(
  values: unknown[],
): DateOrder | 'ambiguous' | 'unneeded' {
  let sawSlashForm = false;
  let dayFirst = false;
  let monthFirst = false;
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(
      asciiDigits(v.trim()),
    );
    if (!m) continue;
    sawSlashForm = true;
    const a = Number(m[1]);
    const b = Number(m[2]);
    if (a > 12 && b <= 12) dayFirst = true;
    if (b > 12 && a <= 12) monthFirst = true;
  }
  if (!sawSlashForm) return 'unneeded';
  if (dayFirst && !monthFirst) return 'dmy';
  if (monthFirst && !dayFirst) return 'mdy';
  if (dayFirst && monthFirst) return 'ambiguous';
  return 'ambiguous';
}
