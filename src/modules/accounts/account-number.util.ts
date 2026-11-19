/**
 * The next account number nobody uses, near `number`: 1200 → 1201, "090" →
 * "091", "ALI-7" → "ALI-8", "CASH" → "CASH-1". `taken` holds every number in
 * use, as `key` writes it (lower-cased and trimmed by default), and gains the
 * one returned.
 */
export function freeNumber(
  number: string,
  taken: Set<string>,
  key: (n: string) => string = (n) => n.trim().toLowerCase(),
): string {
  const m = /^(.*?)(\d+)$/.exec(number);
  for (let i = 1; i < 10_000; i++) {
    const candidate = m
      ? `${m[1]}${String(Number(m[2]) + i).padStart(m[2].length, '0')}`
      : `${number}-${i}`;
    if (!taken.has(key(candidate))) {
      taken.add(key(candidate));
      return candidate;
    }
  }
  throw new Error(`No free account number near ${number}`);
}
