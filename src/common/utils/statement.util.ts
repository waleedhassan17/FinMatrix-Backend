import Decimal from 'decimal.js';
import { toDecimal, type MoneyInput } from './money.util';

/**
 * One event on a party's account, signed the way it moves what they owe: an
 * invoice or bill up, a payment or credit down, a refund back up.
 */
export interface StatementMove {
  date: string;
  amount: MoneyInput;
}

/**
 * The balance before a period and after it, from every event on the account.
 *
 * The opening balance is everything dated before the period; the closing
 * balance adds what falls inside it. Dates are compared as `YYYY-MM-DD`
 * strings, which order the same way the calendar does.
 */
export function statementBalances(
  moves: StatementMove[],
  startDate: string,
  endDate: string,
): { opening: Decimal; closing: Decimal } {
  let opening = new Decimal(0);
  let within = new Decimal(0);
  for (const m of moves) {
    const day = String(m.date).slice(0, 10);
    if (day < startDate) opening = opening.plus(toDecimal(m.amount));
    else if (day <= endDate) within = within.plus(toDecimal(m.amount));
  }
  return { opening, closing: opening.plus(within) };
}

/** Whether an event's date falls inside the period, both ends included. */
export const inPeriod = (date: string, startDate: string, endDate: string): boolean => {
  const day = String(date).slice(0, 10);
  return day >= startDate && day <= endDate;
};
