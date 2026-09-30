// ═══════════════════════════════════════════════════════
// FinMatrix — Rider username generation
// ═══════════════════════════════════════════════════════
// A rider signs in with a username and a password issued by the office. There
// is no self-service recovery, so the username is not a convenience — it is the
// ONLY way in. An account without one cannot be signed into at all, and the
// office has nothing to hand over.
//
// That is exactly what went wrong: `username` was written in a single branch of
// DeliveryPersonnelService.create (the one that makes a brand-new user), so
// riders arriving by self-signup, by companies.join, by the {userId} attach
// path or from a seed were created nameless. Every layer then coalesced the
// NULL to '' and the office saw a blank field with a working Copy button.
//
// This module is the one place that decides what a rider is called, so every
// one of those paths can call it and none of them can disagree.
//
// ⚠ The backfill migration (1789940000000-BackfillRiderUsernames) reimplements
// this rule in PL/pgSQL, because a migration must not import code that can
// change under it. rider-username.spec.ts pins the shape both sides must
// produce; if you change the rule here, change it there and re-run that spec.

import type { EntityManager } from 'typeorm';

/** Leaves room for a numeric suffix inside users.username's varchar(64). */
const MAX_BASE_LENGTH = 58;
/** RIDER_USERNAME_REGEX needs at least 3 characters. */
const MIN_LENGTH = 3;
/** Give up walking suffixes long before this; a company has tens of riders. */
const MAX_ATTEMPTS = 1000;

/**
 * Reduce a name to the character set the username rule allows.
 *
 * Accents are folded rather than stripped, so "Imran Alí" becomes "imranali"
 * and not "imranal" — a rider should recognise their own handle.
 */
export const slugifyRiderName = (raw: string | null | undefined): string =>
  (raw ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * The username a rider gets before collisions are resolved: `<code>.<name>`.
 *
 * The invite code prefixes it because `users.username` is globally unique
 * across every company, and a company-scoped prefix makes a collision between
 * two companies' "imran" impossible rather than merely unlikely.
 *
 * Matches what the admin app already generates
 * (AddDeliveryPersonnelScreen.generateUsername), so a rider named by the
 * backfill is indistinguishable from one created through the form.
 */
export const buildRiderUsernameBase = (args: {
  inviteCode?: string | null;
  displayName?: string | null;
  email?: string | null;
}): string => {
  const code = slugifyRiderName(args.inviteCode) || 'rider';
  const fromName = slugifyRiderName((args.displayName ?? '').trim().split(/\s+/)[0]);
  const fromEmail = slugifyRiderName((args.email ?? '').split('@')[0]);
  const who = fromName || fromEmail || 'rider';

  let base = `${code}.${who}`.slice(0, MAX_BASE_LENGTH);
  // A trailing '.' or '-' would be legal but reads as a typo, and a too-short
  // base fails the rule outright.
  base = base.replace(/[._-]+$/, '');
  while (base.length < MIN_LENGTH) base += '0';
  return base;
};

/**
 * The first free username at or after `base`, as `base`, `base2`, `base3`…
 *
 * A loop rather than one clever query: `users.username` is globally unique, so
 * a batch-local ranking cannot see names already taken by rows outside the
 * batch. Rider counts are small; correctness beats cleverness here.
 */
export const allocateRiderUsername = async (
  em: EntityManager,
  base: string,
): Promise<string> => {
  for (let n = 1; n <= MAX_ATTEMPTS; n += 1) {
    const candidate = n === 1 ? base : `${base}${n}`;
    const taken: unknown[] = await em.query(
      'SELECT 1 FROM users WHERE username = $1 LIMIT 1',
      [candidate],
    );
    if (!taken.length) return candidate;
  }
  // Unreachable in practice. Throwing beats returning a duplicate that the
  // unique index would reject with a much less legible error.
  throw new Error(`Could not allocate a rider username from base "${base}".`);
};

/**
 * Name a user who has no username yet. Returns the username in use either way,
 * so callers can log or return it without a second read.
 */
export const ensureRiderUsername = async (
  em: EntityManager,
  user: { id: string; username?: string | null; displayName?: string | null; email?: string | null },
  inviteCode?: string | null,
): Promise<string> => {
  if (user.username) return user.username;
  const username = await allocateRiderUsername(
    em,
    buildRiderUsernameBase({
      inviteCode,
      displayName: user.displayName,
      email: user.email,
    }),
  );
  await em.query('UPDATE users SET username = $1 WHERE id = $2', [username, user.id]);
  return username;
};
