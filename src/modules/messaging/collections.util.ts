import { addDaysIso } from '../../common/utils/business-date.util';
import { ReminderSchedule } from './messaging.constants';
import { zonedParts } from './quiet-hours.util';

export interface ReminderTarget {
  /** The due date an invoice must have today to get this reminder. */
  dueDate: string;
  /** Signed days from the due date: -3 = three days before, 7 = a week late. */
  offset: number;
  event: 'reminder_upcoming' | 'reminder_overdue';
}

/**
 * Which due dates get a reminder today (company time). `beforeDue: [3]` means
 * invoices due three days from today; `afterDue: [0, 7]` means due today
 * (offset 0, sent as overdue: it is due now) and due a week ago.
 */
export function reminderTargets(
  today: string,
  schedule: ReminderSchedule,
): ReminderTarget[] {
  const out: ReminderTarget[] = [];
  for (const d of new Set(schedule.beforeDue ?? [])) {
    if (Number.isInteger(d) && d > 0)
      out.push({
        dueDate: addDaysIso(today, d),
        offset: -d,
        event: 'reminder_upcoming',
      });
  }
  for (const d of new Set(schedule.afterDue ?? [])) {
    if (Number.isInteger(d) && d >= 0)
      out.push({
        dueDate: addDaysIso(today, -d),
        offset: d,
        event: 'reminder_overdue',
      });
  }
  return out;
}

/** `YYYY-MM-DD` of `now` in `timeZone`. */
export function zonedToday(now: Date, timeZone: string): string {
  const z = zonedParts(now, timeZone);
  return `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;
}

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * Monthly statements go on the 1st from 09:00 company time, for the month
 * that just ended. Returns null at any other time. Later hours of the 1st
 * still qualify (a missed 09:00 run catches up); the per-month docVersion
 * keeps it to one statement per customer per month.
 */
export function statementWindow(
  now: Date,
  timeZone: string,
): { start: string; end: string; label: string; version: number } | null {
  const z = zonedParts(now, timeZone);
  if (z.day !== 1 || z.hour < 9) return null;
  const year = z.month === 1 ? z.year - 1 : z.year;
  const month = z.month === 1 ? 12 : z.month - 1;
  const mm = String(month).padStart(2, '0');
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return {
    start: `${year}-${mm}-01`,
    end: `${year}-${mm}-${String(lastDay).padStart(2, '0')}`,
    label: `${MONTHS[month - 1]} ${year}`,
    version: year * 100 + month,
  };
}
