/**
 * Whether a field really changed between two audit snapshots.
 *
 * Forms send every field on every save, and not always in the stored form: a
 * credit limit of "50000" against the stored "50000.0000", an empty string for
 * a blank phone that was NULL, an address object with its keys in another
 * order or with empty parts. Compared raw, each of those is a "change" nobody
 * made, and a record's history fills with them.
 */
export function normalizeAuditValue(value: unknown, numeric = false): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return null;
    if (numeric) {
      const n = Number(text);
      return Number.isFinite(n) ? n : text;
    }
    return text;
  }
  if (typeof value === 'number') return value;
  if (Array.isArray(value)) return value.map((v) => normalizeAuditValue(v));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as object).sort()) {
      const v = normalizeAuditValue((value as Record<string, unknown>)[key]);
      if (v !== null) out[key] = v;
    }
    return Object.keys(out).length ? out : null;
  }
  return value;
}

/** True when `field` reads the same in both snapshots, once normalized. */
export function sameAuditValue(
  a: unknown,
  b: unknown,
  numeric = false,
): boolean {
  return (
    JSON.stringify(normalizeAuditValue(a, numeric)) ===
    JSON.stringify(normalizeAuditValue(b, numeric))
  );
}
