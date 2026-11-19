import { dayBefore } from '../reports/fiscal-year';

/**
 * The date every Migration Center posting carries: the close of business on
 * the day before the cutover.
 *
 * The cutover date is the FIRST day the books live in FinMatrix — the starter
 * workbook asks for each balance "as it stood at the close of business on the
 * day before", and anything dated the cutover day or later is entered here.
 * So the opening position belongs to the day before, and is dated so:
 *
 *  - Earnings split at the fiscal-year boundary by posting date (retained
 *    earnings are derived at report time; there are no closing entries). A
 *    company whose year starts on the cutover day brings last year's income
 *    in as LAST year's — retained earnings — not as this year's profit; a
 *    mid-year cutover still lands in the current year's figures.
 *  - The first FinMatrix period — the cutover month, quarter or year — holds
 *    only what happened in FinMatrix: its P&L, cash flow and tax return start
 *    clean, and its opening cash is the migrated cash.
 *  - It is the day the period lock closes, so nothing else can be posted
 *    beside the opening balances.
 */
export const openingDateOf = (cutoverDate: string): string =>
  dayBefore(cutoverDate);
