import { addDaysIso } from '../../common/utils/business-date.util';
import { zonedParts, zonedTimeToUtc } from '../messaging/quiet-hours.util';
import {
  DayFigure,
  DayItemCompare,
  DayItemCompareOnly,
  DayItemRow,
  DayItemSheetRow,
  DayItemSheetTotals,
  DayKpi,
} from './day-summary.types';

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

// ── Item-wise sales ─────────────────────────────────────────────────────────

/** The longest period the item sheet covers, in days (a year, leap or not). */
export const MAX_ITEM_SHEET_DAYS = 366;

/** Days from `from` to `to`, both included (1 for a single day). */
export function isoDayCount(from: string, to: string): number {
  const ms = (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((ms(to) - ms(from)) / 86_400_000) + 1;
}

/**
 * The period a sheet is compared with. `previous`: the same number of days
 * just before (yesterday, for one day). `lastWeek`: the same dates a week
 * earlier (the same weekday, for one day).
 */
export function comparePeriod(
  from: string,
  to: string,
  compare: DayItemCompare,
): { from: string; to: string } {
  if (compare === 'lastWeek') {
    return { from: addDaysIso(from, -7), to: addDaysIso(to, -7) };
  }
  const days = isoDayCount(from, to);
  return { from: addDaysIso(from, -days), to: addDaysIso(from, -1) };
}

/** One item's (or service's) figures for a period, as the sheet SQL sums them. */
export interface ItemFigures {
  kind: 'item' | 'service';
  itemId: string | null;
  /** Services are told apart by their wording, case and spacing ignored. */
  serviceKey: string | null;
  name: string;
  code: string | null;
  unit: string | null;
  category: string | null;
  agency: string | null;
  sold: number;
  free: number;
  returned: number;
  value: number;
  returnsValue: number;
  cost: number;
  costMissing: boolean;
}

export const itemFiguresKey = (f: {
  itemId: string | null;
  serviceKey: string | null;
}): string => f.itemId ?? `service:${f.serviceKey ?? ''}`;

const r1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;

/** profit / value as a percentage, or null when there is no value. */
export function marginOf(profit: number, value: number): number | null {
  return Math.abs(value) < 0.005 ? null : r1((profit / value) * 100);
}

/**
 * The sheet's rows and totals from each period's figures. Cost, profit and
 * margin are filled only for a viewer who may see them. Items come before
 * services, each by net sales, largest first.
 */
export function buildItemSheet(
  current: ItemFigures[],
  previous: ItemFigures[] | null,
  showCost: boolean,
): {
  rows: DayItemSheetRow[];
  compareOnly: DayItemCompareOnly[];
  totals: DayItemSheetTotals;
  hasFree: boolean;
} {
  const before = new Map<string, ItemFigures>();
  for (const f of previous ?? []) before.set(itemFiguresKey(f), f);

  const rows: DayItemSheetRow[] = current.map((f) => {
    const value = r2(f.value);
    const cost = r2(f.cost);
    const profit = r2(value - cost);
    // Gross profit is a stock item's: net sales less the cost of the goods. A
    // service or charge carries no cost of goods, so it has none to show.
    const costed = showCost && f.kind === 'item';
    return {
      kind: f.kind,
      itemId: f.itemId,
      code: f.code,
      name: f.name,
      unit: f.unit,
      category: f.category,
      agency: f.agency,
      sold: r2(f.sold),
      free: r2(f.free),
      returned: r2(f.returned),
      net: r2(f.sold + f.free - f.returned),
      value,
      returnsValue: r2(f.returnsValue),
      cost: costed ? cost : null,
      profit: costed ? profit : null,
      margin: costed ? marginOf(profit, value) : null,
      costMissing: costed && f.costMissing,
      compareValue: previous
        ? r2(before.get(itemFiguresKey(f))?.value ?? 0)
        : null,
    };
  });
  rows.sort(
    (a, b) =>
      Number(a.kind === 'service') - Number(b.kind === 'service') ||
      b.value - a.value ||
      a.name.localeCompare(b.name),
  );

  const here = new Set(current.map(itemFiguresKey));
  const compareOnly: DayItemCompareOnly[] = (previous ?? [])
    .filter((f) => !here.has(itemFiguresKey(f)) && Math.abs(f.value) >= 0.005)
    .map((f) => ({
      kind: f.kind,
      itemId: f.itemId,
      name: f.name,
      category: f.category,
      agency: f.agency,
      compareValue: r2(f.value),
    }));

  const sum = (pick: (r: DayItemSheetRow) => number) =>
    r2(rows.reduce((t, r) => t + pick(r), 0));
  const value = sum((r) => r.value);
  // Profit and margin are the stock items': services carry no cost of goods.
  const itemValue = sum((r) => (r.kind === 'item' ? r.value : 0));
  const hasItems = rows.some((r) => r.kind === 'item');
  const cost = showCost && hasItems ? sum((r) => r.cost ?? 0) : null;
  const profit = cost === null ? null : r2(itemValue - cost);
  return {
    rows,
    compareOnly,
    totals: {
      lines: rows.length,
      sold: sum((r) => r.sold),
      free: sum((r) => r.free),
      returned: sum((r) => r.returned),
      net: sum((r) => r.net),
      value,
      returnsValue: sum((r) => r.returnsValue),
      cost,
      profit,
      margin: profit === null ? null : marginOf(profit, itemValue),
      compareValue: previous
        ? r2((previous ?? []).reduce((t, f) => t + f.value, 0))
        : null,
    },
    hasFree: rows.some((r) => r.free > 0),
  };
}

/**
 * The day's best sellers: the item sheet's top lines by net sales (then net
 * units), so the card and the sheet can never disagree. Lines that only came
 * back, or only went out free, are not "sellers".
 */
export function bestSellers(figures: ItemFigures[], n = 5): DayItemRow[] {
  return figures
    .map((f) => ({
      itemId: f.itemId,
      name: f.name,
      quantity: r2(f.sold + f.free - f.returned),
      total: r2(f.value),
    }))
    .filter((r) => r.total > 0)
    .sort(
      (a, b) =>
        b.total - a.total ||
        b.quantity - a.quantity ||
        a.name.localeCompare(b.name),
    )
    .slice(0, n);
}

/** "Thu 19 Nov 2026" for an ISO date, free of any time zone. */
export function longDayLabel(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const part = (o: Intl.DateTimeFormatOptions) =>
    dt.toLocaleDateString('en-GB', { ...o, timeZone: 'UTC' });
  return `${part({ weekday: 'short' })} ${d} ${part({ month: 'short' })} ${y}`;
}
