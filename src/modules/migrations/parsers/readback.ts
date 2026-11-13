import Decimal from 'decimal.js';

/**
 * The second reader.
 *
 * Every amount, quantity and date in a migration is read twice: once by
 * amount.parser.ts / date.parser.ts, which decide the value the books will
 * hold, and once here. The two must agree on every cell, or the cell is
 * raised to the owner and nothing can be imported. A silent misread in one
 * reader is then visible as a disagreement with the other.
 *
 * That only works if the two are genuinely independent, so this file shares
 * nothing with the first reader: not the digit table, not the regexes, not
 * the helpers. It is also deliberately stricter about the SHAPE of a number:
 * the first reader drops every comma and reads what is left, while this one
 * insists the commas sit where a lakh (1,20,000) or a thousands (1,200,000)
 * grouping puts them. "12,0000" reads as 120,000 to the first reader and as
 * unreadable here, and that disagreement is exactly the point: the owner,
 * not a parser, decides what was meant.
 *
 * Nothing here can approve a figure. It can only disagree.
 */

export type ReadbackAmount =
  | { ok: true; value: string | null; side?: 'debit' | 'credit' }
  | { ok: false; reason: string };

export type ReadbackDate =
  | { ok: true; iso: string | null }
  | { ok: false; reason: string };

export type ReadbackOrder = 'dmy' | 'mdy';

/** Digit zero of each script this reader understands, by code point. */
const ZEROS = [0x30, 0x660, 0x6f0]; // ASCII, Arabic-Indic, Extended Arabic-Indic (Urdu)

const CURRENCY_WORDS = new Set(['rs', 'pkr', 'rupee', 'rupees', 'rps']);
const DEBIT_WORDS = new Set(['dr', 'debit']);
const CREDIT_WORDS = new Set(['cr', 'credit']);

/** Lakh grouping, thousands grouping, or no grouping; an optional fraction. */
const LAKH = /^\d{1,2}(,\d{2})*,\d{3}(\.\d+)?$/;
const THOUSANDS = /^\d{1,3}(,\d{3})+(\.\d+)?$/;
const PLAIN = /^(\d+(\.\d+)?|\.\d+)$/;

/** Anything at or beyond this is not a figure in a set of books. */
const TOO_LARGE = new Decimal('1e13');

function digitOf(ch: string): number {
  const cp = ch.codePointAt(0) ?? -1;
  for (const zero of ZEROS) if (cp >= zero && cp <= zero + 9) return cp - zero;
  return -1;
}

/** Each character mapped to what it means to a number, or '' to drop it. */
function classify(ch: string): string {
  const d = digitOf(ch);
  if (d >= 0) return String(d);
  switch (ch) {
    case ',':
    case '٬': // Arabic thousands separator
      return ',';
    case '.':
    case '٫': // Arabic decimal separator
      return '.';
    case ' ':
    case ' ':
      return ' ';
    default:
      return ch;
  }
}

/**
 * Read an amount the way a careful clerk would, from the text as typed.
 * `allowSide` is false for quantities, where a Dr/Cr suffix is a mistake.
 */
export function readbackAmount(
  text: unknown,
  opts: { allowSide: boolean } = { allowSide: true },
): ReadbackAmount {
  if (text === null || text === undefined) return { ok: true, value: null };
  if (typeof text !== 'string')
    return { ok: false, reason: 'the typed text is missing' };
  let s = text.trim();
  if (s === '' || s === '-' || s === '—' || s === '–')
    return { ok: true, value: null };

  // 1. Words: only currency words and a trailing side are allowed.
  let side: 'debit' | 'credit' | undefined;
  const words = s.toLowerCase().match(/[a-z]+/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const last = i === words.length - 1;
    if (CURRENCY_WORDS.has(w)) continue;
    if (last && (DEBIT_WORDS.has(w) || CREDIT_WORDS.has(w))) {
      if (!opts.allowSide)
        return { ok: false, reason: `"${text}" carries a Dr/Cr` };
      // The side must be the final token of the cell, as the clerk wrote it.
      if (!new RegExp(`${w}\\.?\\s*$`, 'i').test(s))
        return { ok: false, reason: `"${text}" has words in it` };
      side = DEBIT_WORDS.has(w) ? 'debit' : 'credit';
      continue;
    }
    return { ok: false, reason: `"${text}" has words in it` };
  }
  s = s
    .replace(/[A-Za-z]+\.?/g, '')
    .replace(/₨/g, '') // ₨
    .replace(/\/-\s*$/, '')
    .trim();

  // 2. Sign: brackets, a leading or a trailing minus (an odd count negates).
  let minuses = 0;
  if (/^\(.*\)$/.test(s)) {
    minuses += 1;
    s = s.slice(1, -1).trim();
  }
  if (/^[-−]/.test(s)) {
    minuses += 1;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) {
    s = s.slice(1).trim();
  }
  if (/[-−]$/.test(s)) {
    minuses += 1;
    s = s.slice(0, -1).trim();
  }

  // 3. Digits of any script, separators of any script.
  const mapped = [...s].map(classify).join('');
  if (/[^\d,. ]/.test(mapped))
    return { ok: false, reason: `"${text}" is not a figure` };
  // A space between groups is a grouping too (1 250).
  const grouped = mapped.replace(/ /g, ',');
  if (!LAKH.test(grouped) && !THOUSANDS.test(grouped) && !PLAIN.test(grouped))
    return {
      ok: false,
      reason: `"${text}" is not grouped the way a number is written`,
    };
  const digits = grouped.replace(/,/g, '');
  let value = new Decimal(digits.startsWith('.') ? `0${digits}` : digits);
  if (value.abs().greaterThanOrEqualTo(TOO_LARGE))
    return { ok: false, reason: `"${text}" is too large to be a figure` };
  if (minuses % 2 === 1) value = value.negated();
  return { ok: true, value: value.toFixed(), ...(side ? { side } : {}) };
}

export function readbackQuantity(text: unknown): ReadbackAmount {
  return readbackAmount(text, { allowSide: false });
}

const MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
];
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const EXCEL_DAY0 = Date.UTC(1899, 11, 30);

function leap(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function ymd(y: number, m: number, d: number): string | null {
  if (m < 1 || m > 12 || d < 1) return null;
  const max = DAYS_IN_MONTH[m - 1] + (m === 2 && leap(y) ? 1 : 0);
  if (d > max) return null;
  const two = (n: number) => (n < 10 ? `0${n}` : String(n));
  return `${y}-${two(m)}-${two(d)}`;
}

function year(raw: string): number {
  const y = Number(raw);
  return raw.length <= 2 ? (y < 70 ? 2000 + y : 1900 + y) : y;
}

function month(word: string): number {
  const i = MONTHS.indexOf(word.toLowerCase().slice(0, 3));
  return i < 0 ? 0 : i + 1;
}

/** Read a date from the text as typed, with the file's decided day/month order. */
export function readbackDate(
  text: unknown,
  order?: ReadbackOrder,
): ReadbackDate {
  if (text === null || text === undefined) return { ok: true, iso: null };
  if (typeof text !== 'string')
    return { ok: false, reason: 'the typed text is missing' };
  const s = [...text.trim()]
    .map((ch) => {
      const d = digitOf(ch);
      return d >= 0 ? String(d) : ch;
    })
    .join('');
  if (s === '') return { ok: true, iso: null };

  // An Excel serial (a number cell).
  if (/^\d{5}$/.test(s)) {
    const n = Number(s);
    if (n >= 20_000 && n <= 80_000) {
      const dt = new Date(EXCEL_DAY0 + n * 86_400_000);
      return {
        ok: true,
        iso: ymd(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate()),
      };
    }
  }
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) {
    const iso = ymd(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso
      ? { ok: true, iso }
      : { ok: false, reason: `"${text}" is not a real date` };
  }
  m = /^(\d{1,2})[-/ .]([A-Za-z]{3,9})[-/ .,]+(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const iso = ymd(year(m[3]), month(m[2]), Number(m[1]));
    return iso
      ? { ok: true, iso }
      : { ok: false, reason: `"${text}" is not a real date` };
  }
  m = /^([A-Za-z]{3,9})[ .-]+(\d{1,2}),?[ .-]+(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const iso = ymd(year(m[3]), month(m[1]), Number(m[2]));
    return iso
      ? { ok: true, iso }
      : { ok: false, reason: `"${text}" is not a real date` };
  }
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    if (!order)
      return { ok: false, reason: `"${text}" needs a day/month order` };
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = year(m[3]);
    const iso = order === 'dmy' ? ymd(y, b, a) : ymd(y, a, b);
    return iso
      ? { ok: true, iso }
      : { ok: false, reason: `"${text}" is not a real date` };
  }
  return { ok: false, reason: `"${text}" is not a date` };
}

export type ReadbackKind = 'amount' | 'quantity' | 'date';

export interface ReadbackVerdict {
  agrees: boolean;
  /** What this reader made of the text, for the owner and the certificate. */
  readback: string;
}

/**
 * Does this reader agree with what the first reader stored? `first` is the
 * value in the staging row (a plain decimal string, or an ISO date), `side`
 * its Dr/Cr if any, `text` the cell as typed.
 */
export function readbackAgrees(
  kind: ReadbackKind,
  first: unknown,
  side: unknown,
  text: unknown,
  order?: ReadbackOrder,
): ReadbackVerdict {
  if (kind === 'date') {
    const r = readbackDate(text, order);
    if (!r.ok) return { agrees: false, readback: r.reason };
    return {
      agrees: (first ?? null) === (r.iso ?? null),
      readback: r.iso ?? '(blank)',
    };
  }
  const r = kind === 'amount' ? readbackAmount(text) : readbackQuantity(text);
  if (!r.ok) return { agrees: false, readback: r.reason };
  if (r.value === null || first === null || first === undefined) {
    return {
      agrees: r.value === null && (first === null || first === undefined),
      readback: r.value ?? '(blank)',
    };
  }
  let same: boolean;
  try {
    same = new Decimal(String(first)).equals(new Decimal(r.value));
  } catch {
    same = false;
  }
  const firstSide = side ?? undefined;
  if (same && (firstSide ?? undefined) !== (r.side ?? undefined)) same = false;
  return {
    agrees: same,
    readback: `${r.value}${r.side ? ` ${r.side === 'debit' ? 'Dr' : 'Cr'}` : ''}`,
  };
}

/**
 * A number cell has no typed text; this is the text it stands for. Fifteen
 * significant digits is what a spreadsheet shows, so 0.30000000000000004
 * reads as 0.3 — a representation, not a parse.
 */
export function numberAsTyped(value: number): string {
  return Number.isFinite(value) ? String(Number(value.toPrecision(15))) : '';
}
