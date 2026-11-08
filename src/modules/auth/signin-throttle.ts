import { ExecutionContext, SetMetadata } from '@nestjs/common';

/**
 * Sign-in rate limits, per account as well as per IP.
 *
 * The global throttler counts requests per IP address. On its own that is the
 * wrong shape for a sign-in door, in both directions:
 *
 * - TOO STRICT for honest traffic. A warehouse shift signs in from one office
 *   Wi-Fi, and mobile carriers put thousands of subscribers behind one public
 *   address (carrier-grade NAT). At 5 per minute per IP the sixth rider at the
 *   gate was told to wait.
 * - TOO LOOSE for an attack on one account. A password guesser that rotates
 *   addresses gets a fresh allowance from every one of them.
 *
 * So /auth/signin is counted twice: per IP with a ceiling an office can live
 * with, and per ACCOUNT (the identifier being signed into) wherever the
 * attempts come from. The second is a named throttler ('account') registered
 * in AppModule; it only runs on handlers marked @AccountThrottle(), and every
 * other route keeps the global per-IP limit alone.
 *
 * Counts live in the throttler's storage — process memory today. When the API
 * runs as more than one instance, give ThrottlerModule a shared store (Redis)
 * so an account's attempts are counted across all of them.
 *
 * TUNABLE BY ENVIRONMENT, read per request (so a value from .env, loaded by
 * ConfigModule after these decorators run, still applies):
 *   SIGNIN_ACCOUNT_LIMIT        attempts per account per window  (default 10)
 *   SIGNIN_ACCOUNT_TTL_SECONDS  that window                      (default 900)
 *   SIGNIN_IP_LIMIT             attempts per IP per minute       (default 30)
 * The acceptance suites sign in as one account dozens of times a run; CI
 * raises these the way it raises THROTTLE_LIMIT. Production uses the defaults.
 */

export const ACCOUNT_THROTTLER = 'account';

/** A positive integer from the environment, or the fallback. */
const envInt = (name: string, fallback: number): number => {
  const n = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

/** Attempts per account, from anywhere, in the window below. */
export const accountSigninLimit = (): number =>
  envInt('SIGNIN_ACCOUNT_LIMIT', 10);
export const accountSigninTtlMs = (): number =>
  envInt('SIGNIN_ACCOUNT_TTL_SECONDS', 15 * 60) * 1000;

/** Attempts per IP address per minute — room for a shared office or carrier address. */
export const ipSigninLimit = (): number => envInt('SIGNIN_IP_LIMIT', 30);
export const IP_SIGNIN_TTL_MS = 60_000;

const ACCOUNT_THROTTLE_KEY = 'auth:accountThrottle';

/** Marks a handler whose body names an account (`identifier` or `email`). */
export const AccountThrottle = () => SetMetadata(ACCOUNT_THROTTLE_KEY, true);

/** Longest identifier the tracker keeps: an email column is varchar(255). */
const MAX_IDENTIFIER = 255;

/**
 * The account a sign-in request is aimed at, normalised the way the user
 * lookup normalises it (trimmed, lower-case), so "Manager" and " manager "
 * share one allowance. Guards run before validation pipes, so the body is
 * untrusted here: anything that is not a non-empty string falls back to the
 * caller's IP, which the per-IP limit already covers.
 */
export const accountTracker = (req: Record<string, any>): string => {
  const body = req?.body ?? {};
  const raw =
    typeof body.identifier === 'string' && body.identifier.trim()
      ? body.identifier
      : typeof body.email === 'string'
        ? body.email
        : '';
  const key = raw.trim().toLowerCase().slice(0, MAX_IDENTIFIER);
  return key ? `account:${key}` : `ip:${req?.ip ?? 'unknown'}`;
};

/** The 'account' throttler runs only where @AccountThrottle() is applied. */
export const skipUnlessAccountThrottled = (
  context: ExecutionContext,
): boolean =>
  Reflect.getMetadata(ACCOUNT_THROTTLE_KEY, context.getHandler()) !== true;
