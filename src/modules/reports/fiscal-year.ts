/**
 * Fiscal-year arithmetic, in one place.
 *
 * The company's fiscal year is defined by ONE field:
 * `companies.fiscal_year_start_month` (1–12, NULL = January). The older
 * `company_settings.fiscal_year_start` ('MM-DD') is derived from it and written
 * through it by SettingsService; nothing reads that column any more. A year
 * always starts on the 1st of its month.
 *
 * A fiscal year is named by the calendar year it STARTS in: a company whose
 * year starts in July has fiscal 2026 running July 2026 – June 2027. That is
 * the convention the customer/vendor history screens already use.
 *
 * Every date here is an ISO calendar day ('YYYY-MM-DD') and every calculation
 * is calendar arithmetic, free of any time zone — the same discipline as
 * business-date.util.
 */
import { addDaysIso } from '../../common/utils/business-date.util';

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A usable start month. NULL, 0, garbage → 1 (January); out-of-range numbers
 * are clamped, as the history screens always clamped them.
 */
export function clampMonth(value: unknown): number {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(12, n);
}

/** The calendar day before `iso`. Leap days included. */
export const dayBefore = (iso: string): string => addDaysIso(iso, -1);

/** The fiscal year (by its start year) that `asOf` falls in. */
export function fiscalYearOf(startMonth: number, asOf: string): number {
  const m = clampMonth(startMonth);
  const y = Number(asOf.slice(0, 4));
  const mo = Number(asOf.slice(5, 7));
  return mo >= m ? y : y - 1;
}

/** First day of the fiscal year that `asOf` falls in. */
export function fiscalYearStart(startMonth: number, asOf: string): string {
  return `${fiscalYearOf(startMonth, asOf)}-${pad(clampMonth(startMonth))}-01`;
}

/** First day of fiscal year `fy` (named by its start year). */
export function fiscalYearStartOf(startMonth: number, fy: number): string {
  return `${fy}-${pad(clampMonth(startMonth))}-01`;
}

/** Last day of fiscal year `fy`: the day before the next one starts. */
export function fiscalYearEndOf(startMonth: number, fy: number): string {
  return dayBefore(fiscalYearStartOf(startMonth, fy + 1));
}

/** Last day of the fiscal year that `asOf` falls in. */
export function fiscalYearEnd(startMonth: number, asOf: string): string {
  return fiscalYearEndOf(startMonth, fiscalYearOf(startMonth, asOf));
}

/**
 * Every fiscal year touched by [from, to], oldest first, each with its full
 * bounds — callers clip to their own range where they need to.
 */
export function fiscalYearsBetween(
  startMonth: number,
  from: string,
  to: string,
): Array<{ fiscalYear: number; startDate: string; endDate: string }> {
  if (from > to) return [];
  const first = fiscalYearOf(startMonth, from);
  const last = fiscalYearOf(startMonth, to);
  const out: Array<{ fiscalYear: number; startDate: string; endDate: string }> =
    [];
  for (let fy = first; fy <= last; fy++) {
    out.push({
      fiscalYear: fy,
      startDate: fiscalYearStartOf(startMonth, fy),
      endDate: fiscalYearEndOf(startMonth, fy),
    });
  }
  return out;
}

/**
 * The period immediately before [start, end], of equal length.
 *
 * When the range is whole calendar months (it starts on a 1st and ends on a
 * month's last day) the comparison is the same number of whole months before
 * it — H2 against H1, a quarter against the one before — because that is what
 * anyone comparing them means. Any other range is compared with the same
 * number of days immediately before it.
 */
export function precedingPeriod(
  start: string,
  end: string,
): { startDate: string; endDate: string } {
  const endDate = dayBefore(start);
  const [ey, em] = end.slice(0, 7).split('-').map(Number);
  const monthEnd = new Date(Date.UTC(ey, em, 0)).toISOString().slice(0, 10);
  if (start.slice(8) === '01' && end === monthEnd) {
    const [sy, sm] = start.slice(0, 7).split('-').map(Number);
    const months = (ey - sy) * 12 + (em - sm) + 1;
    const first = new Date(Date.UTC(sy, sm - 1 - months, 1))
      .toISOString()
      .slice(0, 10);
    return { startDate: first, endDate };
  }
  const days =
    Math.round(
      (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) /
        86_400_000,
    ) + 1;
  return { startDate: addDaysIso(endDate, -(days - 1)), endDate };
}
