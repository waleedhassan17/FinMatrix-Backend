/**
 * Text as a key: how headers, sheet names, party names and account names are
 * compared. Lower-case, diacritics stripped, Urdu and Latin letters and digits
 * kept, everything else dropped — so "Unit Cost", "unit_cost", "UNIT COST*"
 * and "Unit cost (Rs)" are one key, and "Al-Noor Traders" equals "Al Noor
 * Traders". Never used to CHANGE a stored value, only to find it.
 */
export function normalizeKey(value: unknown): string {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\(.*?\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

/** A name for display: trimmed, internal whitespace collapsed. */
export function cleanText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/\s+/g, ' ').trim();
  return text === '' ? null : text;
}

const EASTERN_DIGITS: Record<string, string> = {
  '۰': '0',
  '۱': '1',
  '۲': '2',
  '۳': '3',
  '۴': '4',
  '۵': '5',
  '۶': '6',
  '۷': '7',
  '۸': '8',
  '۹': '9',
  '٠': '0',
  '١': '1',
  '٢': '2',
  '٣': '3',
  '٤': '4',
  '٥': '5',
  '٦': '6',
  '٧': '7',
  '٨': '8',
  '٩': '9',
  '٫': '.', // Arabic decimal separator
  '٬': ',', // Arabic thousands separator
};

/** Urdu and Arabic-Indic digits to ASCII; a sheet typed in Urdu stays a number. */
export function asciiDigits(text: string): string {
  return text.replace(/[۰-۹٠-٩٫٬]/g, (ch) => EASTERN_DIGITS[ch] ?? ch);
}

/**
 * Edit similarity in [0, 1] (1 = identical), for "nearly the same header".
 * Damerau-free Levenshtein over normalised keys; short strings are compared
 * strictly so "qty" never fuzzy-matches "city".
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  if (a.length < 4 || b.length < 4) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  let prev = new Array<number>(cols).fill(0).map((_, j) => j);
  for (let i = 1; i < rows; i++) {
    const cur = new Array<number>(cols).fill(0);
    cur[0] = i;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  const distance = prev[cols - 1];
  return 1 - distance / Math.max(a.length, b.length);
}
