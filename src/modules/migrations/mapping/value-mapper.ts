import { normalizeKey, similarity } from '../parsers/text-normalize';
import { VALUE_SYNONYMS } from '../targets';

export interface ValueProposal {
  value: string | null;
  confidence: number;
  reason: string;
}

/**
 * A source value of an enum field → its canonical target value.
 * Exact synonyms are certain; a near-miss is a proposal below the confidence
 * bar, which becomes a question with the canonical values as options.
 */
export function mapEnumValue(field: string, raw: unknown): ValueProposal {
  const table = VALUE_SYNONYMS[field];
  const key = normalizeKey(raw);
  if (!table || !key) return { value: null, confidence: 0, reason: 'blank' };
  for (const [canonical, synonyms] of Object.entries(table)) {
    if (normalizeKey(canonical) === key)
      return { value: canonical, confidence: 1, reason: 'exact' };
    if (synonyms.some((s) => normalizeKey(s) === key))
      return { value: canonical, confidence: 1, reason: 'known spelling' };
  }
  let best: ValueProposal = {
    value: null,
    confidence: 0,
    reason: `"${String(raw)}" is not a value we know`,
  };
  for (const [canonical, synonyms] of Object.entries(table)) {
    for (const s of [canonical, ...synonyms]) {
      const sk = normalizeKey(s);
      if (sk.length >= 4 && key.includes(sk) && best.confidence < 0.8) {
        best = { value: canonical, confidence: 0.8, reason: `contains "${s}"` };
      }
      if (similarity(sk, key) >= 0.8 && best.confidence < 0.7) {
        best = {
          value: canonical,
          confidence: 0.7,
          reason: `looks like "${s}"`,
        };
      }
    }
  }
  return best;
}

export const enumOptions = (field: string): string[] =>
  Object.keys(VALUE_SYNONYMS[field] ?? {});
