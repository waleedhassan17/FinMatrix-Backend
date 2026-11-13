import { normalizeKey } from '../parsers/text-normalize';

export interface ExistingMaster {
  id: string;
  code: string | null;
  name: string;
}

export interface MasterRow {
  code?: string | null;
  name?: string | null;
}

export interface MasterMatch {
  /** Existing record the row is the same as, by code first, then exact name. */
  recordId: string | null;
  by: 'code' | 'name' | null;
  /** Index of an earlier row in the same batch that is the same master. */
  duplicateOf: number | null;
}

/**
 * Masters (customers, vendors, items) against what the company already has
 * and against each other.
 *
 * A code is an identity: the same code is the same party, whatever the name.
 * Without a code, an exactly equal normalised name is the same party. Anything
 * looser is a question (the fuzzy candidates are offered on the issue), never
 * a merge — two shops called "Bismillah Traders" in two cities are two
 * customers until the owner says otherwise.
 */
export function matchMasters(
  rows: MasterRow[],
  existing: ExistingMaster[],
): MasterMatch[] {
  const byCode = new Map<string, ExistingMaster>();
  const byName = new Map<string, ExistingMaster>();
  for (const e of existing) {
    const c = normalizeKey(e.code);
    if (c && !byCode.has(c)) byCode.set(c, e);
    const n = normalizeKey(e.name);
    if (n && !byName.has(n)) byName.set(n, e);
  }
  const seenCode = new Map<string, number>();
  const seenName = new Map<string, number>();
  return rows.map((row, i) => {
    const code = normalizeKey(row.code);
    const name = normalizeKey(row.name);
    let duplicateOf: number | null = null;
    if (code && seenCode.has(code)) duplicateOf = seenCode.get(code)!;
    else if (name && seenName.has(name)) duplicateOf = seenName.get(name)!;
    if (code && !seenCode.has(code)) seenCode.set(code, i);
    if (name && !seenName.has(name)) seenName.set(name, i);
    if (duplicateOf !== null) return { recordId: null, by: null, duplicateOf };
    if (code && byCode.has(code))
      return { recordId: byCode.get(code)!.id, by: 'code', duplicateOf: null };
    if (name && byName.has(name))
      return { recordId: byName.get(name)!.id, by: 'name', duplicateOf: null };
    return { recordId: null, by: null, duplicateOf: null };
  });
}

/** Up to `limit` masters whose names share the most with `name` — for an issue's options. */
export function nearestMasters<T extends { name: string }>(
  name: string,
  pool: T[],
  limit = 5,
): T[] {
  const key = normalizeKey(name);
  if (!key) return [];
  const scored = pool
    .map((p) => {
      const pk = normalizeKey(p.name);
      let score = 0;
      if (pk === key) score = 1;
      else if (pk.includes(key) || key.includes(pk)) score = 0.8;
      else {
        const a = new Set(key.match(/.{1,3}/g) ?? []);
        const b = new Set(pk.match(/.{1,3}/g) ?? []);
        const common = [...a].filter((x) => b.has(x)).length;
        score = common / Math.max(1, Math.max(a.size, b.size));
      }
      return { p, score };
    })
    .filter((s) => s.score >= 0.3)
    .sort((x, y) => y.score - x.score)
    .slice(0, limit);
  return scored.map((s) => s.p);
}
