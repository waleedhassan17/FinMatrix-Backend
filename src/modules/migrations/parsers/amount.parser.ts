import Decimal from 'decimal.js';
import { asciiDigits } from './text-normalize';

export interface ParsedAmount {
  /** Plain decimal string, e.g. "120000.5", "-1200". Never a float. */
  value: string;
  /** A trailing Dr/Cr the cell carried (Tally-style balances). */
  side?: 'debit' | 'credit';
}

export type AmountResult =
  | { ok: true; amount: ParsedAmount | null }
  | { ok: false; error: string };

/** Nothing in these books is anywhere near this. */
const UPPER_LIMIT = new Decimal('1e13');

/**
 * An amount as people actually type it, or a sentence about why it is not one.
 *
 *   1,20,000   120,000   Rs 1,20,000   PKR 120000.50   ₨ 12,500/-   (1,200)
 *   -1200      1200 Dr   1,200 Cr      ۱۲۰۰۰۰ (Urdu digits)   "" → blank
 *
 * The lakh grouping (1,20,000) is the commonest form in Pakistan and is what
 * breaks every parser written for 1,200,000; both are accepted by ignoring
 * commas entirely once the string is otherwise a number. Brackets or a
 * leading minus make it negative. A number cell from Excel is taken through
 * toPrecision(15) so 0.30000000000000004 reads as 0.3. No rounding happens
 * here: the value is returned at whatever precision the file carried, and
 * every downstream comparison is exact.
 */
export function parseAmount(input: unknown): AmountResult {
  if (input === null || input === undefined) return { ok: true, amount: null };
  if (typeof input === 'number') {
    if (!Number.isFinite(input))
      return { ok: false, error: 'is not a number.' };
    return finish(new Decimal(input.toPrecision(15)));
  }
  if (typeof input === 'boolean')
    return { ok: false, error: 'is TRUE/FALSE, not an amount.' };
  if (input instanceof Date)
    return { ok: false, error: 'is a date, not an amount.' };
  if (typeof input === 'object')
    return { ok: false, error: 'is not an amount.' };

  const original = String(input).trim();
  if (original === '' || original === '-' || original === '—')
    return { ok: true, amount: null };

  let text = asciiDigits(original);
  let side: 'debit' | 'credit' | undefined;
  const sideMatch = /\s*(dr|cr|debit|credit)\.?\s*$/i.exec(text);
  if (sideMatch) {
    side = /^(dr|debit)/i.test(sideMatch[1]) ? 'debit' : 'credit';
    text = text.slice(0, sideMatch.index);
  }
  // Currency words and symbols, anywhere.
  text = text
    .replace(/(rs\.?|pkr|rupees?|₨|rps\.?)/gi, '')
    .replace(/\/-$/, '')
    .replace(/\s+/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith('-') || text.startsWith('−')) {
    negative = !negative;
    text = text.slice(1);
  } else if (text.startsWith('+')) {
    text = text.slice(1);
  }
  if (text.endsWith('-')) {
    negative = !negative;
    text = text.slice(0, -1);
  }
  if (!/^\d[\d,]*(\.\d+)?$|^\.\d+$/.test(text)) {
    return { ok: false, error: `"${original}" is not an amount.` };
  }
  const digits = text.replace(/,/g, '');
  let value = new Decimal(digits);
  if (negative) value = value.negated();
  return finish(value, side);
}

function finish(value: Decimal, side?: 'debit' | 'credit'): AmountResult {
  if (value.abs().greaterThanOrEqualTo(UPPER_LIMIT))
    return { ok: false, error: 'is too large to be an amount.' };
  return {
    ok: true,
    amount: { value: value.toFixed(), ...(side ? { side } : {}) },
  };
}

/** A quantity: an amount that must not carry Dr/Cr. */
export function parseQuantity(input: unknown): AmountResult {
  const r = parseAmount(input);
  if (!r.ok || !r.amount) return r;
  if (r.amount.side)
    return { ok: false, error: 'is an amount with Dr/Cr, not a quantity.' };
  return r;
}
