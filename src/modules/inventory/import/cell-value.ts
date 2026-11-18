import Decimal from 'decimal.js';

/**
 * Reading a spreadsheet cell as the value an import column needs.
 *
 * exceljs hands back whatever Excel stored: a number, a string, a boolean, a
 * Date, rich text, a hyperlink, a formula with (or without) its cached result,
 * or an error like `#N/A`. A CSV hands back strings. Every one of those has to
 * become either a clean value or a sentence the user can act on — never a
 * silently wrong number.
 */
export class CellError extends Error {}

/** The value reads fine but is below zero — a different problem from "can't be read". */
export class NegativeValueError extends CellError {
  constructor(readonly value: string) {
    super('cannot be negative.');
  }
}

const UPPER_LIMIT = new Decimal('1e12');

/**
 * How a sheet writes "nothing here": a dash (Excel's Accounting format shows
 * zero as "-", and a CSV saved from it keeps the dash), N/A, nil, none. Read
 * as a blank cell, never as an error.
 */
const PLACEHOLDER = /^(?:[-‐‑‒–—―]+|n\/?a|nil|none|null)$/i;

export const isPlaceholder = (text: string): boolean =>
  PLACEHOLDER.test(text.trim());

export interface DecimalOptions {
  /** Quantity columns: "12 pcs", "5 sets" read as 12 and 5. Never prices. */
  unitSuffix?: boolean;
}

/** Unwrap rich text, hyperlinks and formulas down to a plain value. */
function unwrap(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'object' || value instanceof Date) return value;

  const v = value as Record<string, unknown>;
  if (Array.isArray(v.richText)) {
    return (v.richText as Array<{ text?: string }>)
      .map((r) => r.text ?? '')
      .join('');
  }
  if ('formula' in v || 'sharedFormula' in v) {
    if (v.result === undefined || v.result === null) {
      throw new CellError(
        'has a formula with no saved value. Open the file in Excel, save it, and upload it again.',
      );
    }
    return unwrap(v.result);
  }
  if ('error' in v) throw new CellError(`shows the error ${String(v.error)}.`);
  if ('text' in v) return unwrap(v.text); // a hyperlink: { text, hyperlink }
  return null;
}

/** A plain-text value, trimmed; empty becomes null. */
export function cellToText(value: unknown): string | null {
  const v = unwrap(value);
  if (v === null) return null;
  if (typeof v === 'number')
    return Number.isFinite(v) ? numberToPlain(v) : null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const text = String(v).trim();
  return text === '' ? null : text;
}

/**
 * A non-negative decimal as a plain string (`"1250.5"`), or null when blank.
 *
 * Numbers are taken through toPrecision(15) first: Excel stores `0.1 + 0.2` as
 * 0.30000000000000004, and without that a price of 0.3 would fail the
 * decimal-places check for a reason no user could see in the cell.
 *
 * Typed amounts are read the ways they are actually written: "Rs 1,250.50",
 * "PKR 1250", "1250/-" and "Rs. 1,250/=" (the Pakistani way of closing an
 * amount), "(5)" as an accounting negative, and — for quantity columns only —
 * "12 pcs". A placeholder such as "-" or "N/A" is a blank cell.
 */
export function cellToDecimal(
  value: unknown,
  decimals: number,
  opts: DecimalOptions = {},
): string | null {
  const v = unwrap(value);
  if (v === null) return null;

  let parsed: Decimal;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new CellError('is not a number.');
    parsed = new Decimal(v.toPrecision(15));
  } else if (v instanceof Date) {
    throw new CellError('is a date, not a number.');
  } else if (typeof v === 'boolean') {
    throw new CellError('is TRUE/FALSE, not a number.');
  } else {
    const raw = String(v).trim();
    if (raw === '' || isPlaceholder(raw)) return null;
    let text = raw
      .replace(/^(rs\.?|pkr)\s*/i, '') // "Rs 1,250", "PKR 1250"
      .replace(/\s*\/\s*[-=]$/, ''); // "1250/-", "1250/="
    if (opts.unitSuffix) text = text.replace(/\s*[a-z][a-z.]*$/i, ''); // "12 pcs"
    let cleaned = text.replace(/[,\s]/g, ''); // "1,000", "1 250"
    const accountingNegative = /^\((.+)\)$/.exec(cleaned); // "(5)"
    if (accountingNegative) cleaned = `-${accountingNegative[1]}`;
    if (!/^-?\d+(\.\d+)?$/.test(cleaned))
      throw new CellError(`"${raw}" is not a number.`);
    parsed = new Decimal(cleaned);
  }

  if (parsed.isNegative() && !parsed.isZero())
    throw new NegativeValueError(parsed.toFixed());
  if (parsed.greaterThanOrEqualTo(UPPER_LIMIT))
    throw new CellError('is too large.');
  if (parsed.decimalPlaces() > decimals) {
    throw new CellError(
      decimals === 0
        ? 'must be a whole number.'
        : `can have at most ${decimals} decimal place${decimals === 1 ? '' : 's'}.`,
    );
  }
  return parsed.abs().toFixed();
}

const TRUE_WORDS = new Set(['yes', 'y', 'true', '1', 'active']);
const FALSE_WORDS = new Set(['no', 'n', 'false', '0', 'inactive']);

/** Yes/No (and friends) as a boolean, or null when blank. */
export function cellToBoolean(value: unknown): boolean | null {
  const v = unwrap(value);
  if (v === null) return null;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    if (v === 1) return true;
    if (v === 0) return false;
  }
  const word = String(v).trim().toLowerCase();
  if (word === '' || isPlaceholder(word)) return null;
  if (TRUE_WORDS.has(word)) return true;
  if (FALSE_WORDS.has(word)) return false;
  throw new CellError(`"${String(v).trim()}" should be Yes or No.`);
}

/** True when the cell holds nothing a user typed. */
export function isBlankCell(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'object' && !(value instanceof Date)) {
    const v = value as Record<string, unknown>;
    if (Array.isArray(v.richText)) {
      return (v.richText as Array<{ text?: string }>).every(
        (r) => !(r.text ?? '').trim(),
      );
    }
  }
  return false;
}

/** 1250 → "1250", 0.5 → "0.5", 1e21 → "1000000000000000000000" — never "1e+21". */
function numberToPlain(n: number): string {
  return new Decimal(n.toPrecision(15)).toFixed();
}
