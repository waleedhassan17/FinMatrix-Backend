import { normalizeKey, similarity } from '../parsers/text-normalize';
import { TargetSheet } from '../targets';
import { fieldForHeader } from './sheet-detector';

export interface ColumnProposal {
  /** Header text as it appears in the file. */
  header: string;
  /** 0-based column index in the grid. */
  column: number;
  field: string | null;
  confidence: number;
  origin: 'profile' | 'rule';
  reason: string;
}

/**
 * Source headers → target fields, deterministically.
 *
 *   1. a saved profile (what this company confirmed last time)     1.00
 *   2. the exact header or a known synonym                           1.00
 *   3. a header that CONTAINS a synonym ("Customer Name (as per NTN)") 0.85
 *   4. a near-miss by edit distance ("Invioce No")                    0.75
 *   anything else is left unmapped and reported, never defaulted.
 *
 * One field per column: when two headers claim the same field the more
 * confident keeps it and the other is unmapped with the reason.
 */
export function mapColumns(
  headers: string[],
  target: TargetSheet,
  profile?: Record<string, string>,
): ColumnProposal[] {
  const proposals: ColumnProposal[] = headers.map((header, column) => {
    if (!header.trim())
      return {
        header,
        column,
        field: null,
        confidence: 0,
        origin: 'rule',
        reason: 'blank header',
      };
    const key = normalizeKey(header);
    const fromProfile = profile?.[key];
    if (fromProfile && target.fields.some((f) => f.key === fromProfile)) {
      return {
        header,
        column,
        field: fromProfile,
        confidence: 1,
        origin: 'profile',
        reason: 'confirmed in an earlier migration',
      };
    }
    const exact = fieldForHeader(target, header);
    if (exact)
      return {
        header,
        column,
        field: exact,
        confidence: 1,
        origin: 'rule',
        reason: 'known column name',
      };

    let best: { field: string; confidence: number; reason: string } | null =
      null;
    for (const field of target.fields) {
      for (const syn of [field.header, ...field.synonyms]) {
        const sk = normalizeKey(syn);
        if (sk.length >= 4 && key.includes(sk)) {
          const c = 0.85;
          if (!best || c > best.confidence)
            best = {
              field: field.key,
              confidence: c,
              reason: `contains "${syn}"`,
            };
        }
        const sim = similarity(sk, key);
        if (sim >= 0.8) {
          const c = 0.75;
          if (!best || c > best.confidence)
            best = {
              field: field.key,
              confidence: c,
              reason: `looks like "${syn}"`,
            };
        }
      }
    }
    return best
      ? {
          header,
          column,
          field: best.field,
          confidence: best.confidence,
          origin: 'rule',
          reason: best.reason,
        }
      : {
          header,
          column,
          field: null,
          confidence: 0,
          origin: 'rule',
          reason: 'not a column we import',
        };
  });

  // One field per column.
  const byField = new Map<string, ColumnProposal[]>();
  for (const p of proposals)
    if (p.field) byField.set(p.field, [...(byField.get(p.field) ?? []), p]);
  for (const [field, list] of byField) {
    if (list.length < 2) continue;
    list.sort((a, b) => b.confidence - a.confidence || a.column - b.column);
    for (const loser of list.slice(1)) {
      loser.field = null;
      loser.confidence = 0;
      loser.reason = `"${list[0].header}" already maps to ${field}`;
    }
  }
  return proposals;
}

/** The fields a mapping leaves uncovered, split by whether that blocks the import. */
export function missingFields(
  target: TargetSheet,
  proposals: ColumnProposal[],
) {
  const mapped = new Set(proposals.filter((p) => p.field).map((p) => p.field));
  return {
    required: target.fields.filter((f) => f.required && !mapped.has(f.key)),
    optional: target.fields.filter((f) => !f.required && !mapped.has(f.key)),
  };
}
