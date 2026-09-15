// ═══════════════════════════════════════════════════════
// FinMatrix — Contact normalisation for uniqueness checks
// ═══════════════════════════════════════════════════════
// The free-trial guarantee ("one trial per email, one per phone") is enforced
// by unique indexes on trial_claims. An index compares strings, so it enforces
// nothing unless every spelling of the same address or number reaches it as
// the SAME string. That is this file's only job.
//
// Unlike normalizePkPhone (phone.ts), which hands unrecognised input back so the
// form validator can show a friendly message, these functions return null for
// anything that is not a real address/number. A uniqueness key must never be
// garbage: storing "0300-abc" would let "0300-abd" through as a different person.

import { isValidPkPhone, normalizePkPhone } from './phone';

/**
 * Trim + lowercase. Returns null for blank input or anything that is not
 * shaped like an address.
 *
 * DELIBERATELY does NOT strip Gmail dots or "+tag" suffixes. Those rules are
 * provider-specific (dots are significant at most providers other than Gmail),
 * so applying them would treat two genuinely different people as one and lock
 * the second out of a trial with no way to understand why. Someone determined
 * to farm trials with aliases still has to verify each inbox AND supply a
 * distinct phone number, and every request is reviewed by a person.
 */
export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const email = raw.trim().toLowerCase();
  if (email === '') return null;
  // One @, something on both sides, a dot in the domain, no whitespace.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  return email;
}

/**
 * Canonical Pakistani E.164 (+923001234567), or null when the input is not a
 * valid Pakistani mobile or landline.
 *
 *   03001234567 · +923001234567 · 923001234567 · 00923001234567
 *
 * all produce "+923001234567". Landlines are accepted because company phones
 * legitimately are landlines (the same policy as IsPkPhone({ allowLandline })).
 */
export function normalizePhone(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const stripped = raw.replace(/[\s\-().]/g, '');
  if (stripped === '') return null;
  // International dialling prefix: 00 92… is +92…. Handled here because
  // normalizePkPhone would read the leading 0 as a local trunk prefix and
  // produce +920923…, which is not a number.
  const withPlus = stripped.startsWith('00') ? `+${stripped.slice(2)}` : stripped;
  const canonical = normalizePkPhone(withPlus);
  if (!canonical || !isValidPkPhone(canonical, true)) return null;
  return canonical;
}
