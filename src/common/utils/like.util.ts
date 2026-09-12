/**
 * Search terms for ILIKE.
 *
 * A term goes into the pattern literally: `%` and `_` are escaped, so a user
 * typing "50%" or "INV_1" is searching for those characters, not issuing a
 * wildcard that matches every row. Postgres LIKE uses backslash as its escape
 * character by default, so the backslash itself is escaped first.
 */
export const escapeLike = (term: string): string =>
  term.replace(/[\\%_]/g, (c) => `\\${c}`);

/** `%term%`, escaped — for "contains" matches. */
export const likeContains = (term: string): string =>
  `%${escapeLike(term.trim())}%`;

/** Shortest query the global search runs; one character matches most of a ledger. */
export const MIN_SEARCH_LENGTH = 2;
