import Decimal from 'decimal.js';

/**
 * Money utilities — NEVER use JS floats for monetary calculations.
 * All monetary columns are decimal(18,4) in Postgres.
 */

export const MONEY_SCALE = 4;
export const MONEY_TOLERANCE = new Decimal('0.0001');

export type MoneyInput = string | number | Decimal;

export function toDecimal(value: MoneyInput | null | undefined): Decimal {
  if (value === null || value === undefined || value === '') return new Decimal(0);
  return new Decimal(value);
}

export function toMoneyString(value: MoneyInput): string {
  return toDecimal(value).toFixed(MONEY_SCALE);
}

export function addMoney(...values: MoneyInput[]): Decimal {
  return values.reduce<Decimal>((acc, v) => acc.plus(toDecimal(v)), new Decimal(0));
}

export function subtractMoney(a: MoneyInput, b: MoneyInput): Decimal {
  return toDecimal(a).minus(toDecimal(b));
}

export function multiplyMoney(a: MoneyInput, b: MoneyInput): Decimal {
  return toDecimal(a).times(toDecimal(b));
}

/**
 * Equality check with money tolerance (default 0.0001).
 * Used for asserting that SUM(debits) === SUM(credits) in journal entries.
 */
export function moneyEquals(
  a: MoneyInput,
  b: MoneyInput,
  tolerance: Decimal = MONEY_TOLERANCE,
): boolean {
  return toDecimal(a).minus(toDecimal(b)).abs().lessThanOrEqualTo(tolerance);
}

export function isPositive(value: MoneyInput): boolean {
  return toDecimal(value).greaterThan(0);
}

export function isZero(value: MoneyInput): boolean {
  return toDecimal(value).isZero();
}
