import { cellToText } from '../../inventory/import/cell-value';
import { MigrationEntityType } from '../entities/migration-staging-row.entity';
import { normalizeKey, similarity } from '../parsers/text-normalize';
import { NOISE_SHEET_NAMES, TARGET_SHEETS, TargetSheet } from '../targets';

export interface SheetDetection {
  target: MigrationEntityType | null;
  confidence: number;
  reason: string;
  /** Index into the grid's rows of the header row (−1 when none found). */
  headerRowIndex: number;
  headers: string[];
  /** Other targets that fit nearly as well — the options for the owner. */
  alternatives: Array<{ target: MigrationEntityType; confidence: number }>;
}

/** Rows searched for the header: a title line or two above it is fine. */
const HEADER_SEARCH_ROWS = 12;

/** A header cell's text — may be rich text when partly bolded. */
export function headerLabel(value: unknown): string {
  try {
    return cellToText(value) ?? '';
  } catch {
    return '';
  }
}

/** Which target field a header names, by exact normalised synonym. */
export function fieldForHeader(
  target: TargetSheet,
  header: string,
): string | null {
  const key = normalizeKey(header);
  if (!key) return null;
  for (const field of target.fields) {
    if (normalizeKey(field.header) === key) return field.key;
    if (field.synonyms.some((s) => normalizeKey(s) === key)) return field.key;
  }
  return null;
}

function headerScore(target: TargetSheet, headers: string[]): number {
  const found = new Set<string>();
  for (const h of headers) {
    const f = fieldForHeader(target, h);
    if (f) found.add(f);
  }
  const sig =
    target.signature.filter((k) => found.has(k)).length /
    target.signature.length;
  const required = target.fields.filter((f) => f.required);
  const req = required.length
    ? required.filter((f) => found.has(f.key)).length / required.length
    : 1;
  const any =
    found.size / Math.max(1, Math.min(target.fields.length, headers.length));
  return Math.min(1, sig * 0.6 + req * 0.3 + any * 0.1);
}

function nameScore(target: TargetSheet, sheetName: string): number {
  const key = normalizeKey(sheetName.split('/').pop() ?? sheetName);
  if (!key) return 0;
  if (normalizeKey(target.name) === key) return 1;
  let best = 0;
  for (const s of target.synonyms) {
    const sk = normalizeKey(s);
    if (sk === key) return 1;
    if (key.includes(sk) && sk.length >= 4) best = Math.max(best, 0.9);
    best = Math.max(best, similarity(sk, key) >= 0.85 ? 0.8 : 0);
  }
  return best;
}

/**
 * Which target sheet a source sheet is, and where its header row sits.
 *
 * The header row is the row (within the first dozen) whose cells name the
 * most target fields across all targets. Confidence combines the sheet's
 * name and its headers: a known name with fitting headers is certain; a
 * nameless CSV is judged by headers alone, and needs every signature field
 * to be certain. Customers and Vendors share a signature (just "Name"), so a
 * sheet called "Parties" with Name/Phone/Email is reported with both as
 * alternatives and the owner picks — never guessed.
 */
export function detectSheet(
  name: string,
  rows: Array<{ cells: unknown[] }>,
): SheetDetection {
  const short = normalizeKey(name.split('/').pop() ?? name);
  if (NOISE_SHEET_NAMES.some((n) => normalizeKey(n) === short)) {
    return {
      target: null,
      confidence: 0,
      reason: 'noise',
      headerRowIndex: -1,
      headers: [],
      alternatives: [],
    };
  }

  // Header row: the best-matching row in the first few.
  let headerRowIndex = -1;
  let headerMatches = 0;
  let headers: string[] = [];
  rows.slice(0, HEADER_SEARCH_ROWS).forEach((row, i) => {
    const labels = row.cells.map(headerLabel);
    const matches = TARGET_SHEETS.reduce(
      (best, t) =>
        Math.max(best, labels.filter((l) => fieldForHeader(t, l)).length),
      0,
    );
    if (matches > headerMatches) {
      headerMatches = matches;
      headerRowIndex = i;
      headers = labels;
    }
  });
  if (headerRowIndex === -1) {
    return {
      target: null,
      confidence: 0,
      reason: 'no header row',
      headerRowIndex: -1,
      headers: [],
      alternatives: [],
    };
  }

  const nameScores = new Map(
    TARGET_SHEETS.map((t) => [t.key, nameScore(t, name)]),
  );
  const scored = TARGET_SHEETS.map((t) => {
    const hs = headerScore(t, headers);
    const ns = nameScores.get(t.key) ?? 0;
    // The sheet is clearly named for ANOTHER target: headers alone must not
    // carry this one ("سپلائر" with Name/Phone is vendors, not customers).
    const namedElsewhere = [...nameScores].some(
      ([k, v]) => k !== t.key && v >= 0.9,
    );
    let confidence: number;
    let reason: string;
    if (ns >= 0.9 && hs >= 0.5) {
      confidence = Math.min(1, 0.6 + 0.4 * hs);
      reason = `sheet name "${name}" and ${Math.round(hs * 100)}% of the expected columns`;
    } else if (ns >= 0.9) {
      confidence = 0.5 + 0.3 * hs;
      reason = `sheet name "${name}" but few of the expected columns`;
    } else {
      confidence = hs >= 0.99 ? 1 : hs * 0.9 + ns * 0.1;
      if (namedElsewhere && ns < 0.5)
        confidence = Math.max(0, confidence - 0.3);
      reason = `${Math.round(hs * 100)}% of the expected columns`;
    }
    return { target: t.key, confidence: round3(confidence), reason };
  }).sort((a, b) => b.confidence - a.confidence);

  const best = scored[0];
  const alternatives = scored
    .slice(1)
    .filter((s) => s.confidence >= 0.5 && best.confidence - s.confidence < 0.25)
    .map((s) => ({ target: s.target, confidence: s.confidence }));
  if (best.confidence < 0.5) {
    return {
      target: null,
      confidence: best.confidence,
      reason: 'does not look like any sheet we import',
      headerRowIndex,
      headers,
      alternatives: [],
    };
  }
  // A tie between look-alikes (Customers vs Vendors, "Parties" with Name and
  // Phone) is a question, not a pick — however confident each one looks.
  const nearTie = alternatives.some(
    (a) => best.confidence - a.confidence < 0.1,
  );
  if (alternatives.length > 0 && (nearTie || best.confidence < 0.9)) {
    return {
      target: best.target,
      confidence: round3(Math.min(best.confidence, 0.6)),
      reason: `could be ${[best.target, ...alternatives.map((a) => a.target)].join(' or ')}`,
      headerRowIndex,
      headers,
      alternatives,
    };
  }
  return {
    target: best.target,
    confidence: best.confidence,
    reason: best.reason,
    headerRowIndex,
    headers,
    alternatives,
  };
}

const round3 = (n: number) => Math.round(n * 1000) / 1000;
