/**
 * Sentry instrumentation (phase6). MUST be imported as the very first line
 * of main.ts so the SDK initializes before Nest bootstraps.
 *
 * The DSN comes ONLY from process.env.SENTRY_DSN — never hardcoded. When it
 * is unset (local dev), Sentry is not initialized and the app boots normally.
 *
 * PRIVACY (this app handles payments and accounting data): the prompt's
 * `dataCollection: { userInfo: false, httpBodies: [] }` option does not exist
 * in the current SDK — per the official @sentry/nestjs docs the equivalents
 * are `sendDefaultPii: false` plus a requestDataIntegration that excludes
 * bodies/cookies/user/IP. A `beforeSend` scrubber is the second, hard guard:
 * it strips auth headers, cookies, and any password/token/card/bank/IBAN/
 * screenshot fields from every event before it leaves the process.
 */
import * as Sentry from '@sentry/nestjs';

// Keys whose VALUES must never reach Sentry, wherever they appear.
const SENSITIVE_KEY_PATTERN =
  /authorization|cookie|password|passwd|secret|token|jwt|api[-_]?key|card|cvv|iban|bank[-_]?account|account[-_]?number|screenshot|bill[-_]?photo|pod[-_]?photo/i;

/** Recursively redact sensitive keys and image URLs from a plain object. */
function scrub(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (typeof value === 'string') {
    // Payment-screenshot / POD image URLs must not leak.
    if (/cloudinary\.com|bill-photo|screenshot/i.test(value)) return '[Redacted URL]';
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => scrub(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY_PATTERN.test(k) ? '[Redacted]' : scrub(v, depth + 1);
    }
    return out;
  }
  return value;
}

if (process.env.SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.SENTRY_DSN,
    environment: process.env.NODE_ENV || 'development',
    // Release: Heroku build commit when available, else the package version.
    release:
      process.env.HEROKU_SLUG_COMMIT ||
      process.env.SOURCE_VERSION ||
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      `finmatrix-backend@${require('../package.json').version}`,

    // ── Privacy: never send PII or request bodies ──
    sendDefaultPii: false,
    integrations: [
      Sentry.requestDataIntegration({
        include: {
          data: false, // request bodies
          cookies: false,
          ip: false,
          query_string: false,
          headers: false,
        },
      }),
    ],
    // Error monitoring only — no performance tracing overhead.
    tracesSampleRate: 0,

    // Second guard: deep-scrub whatever still reaches the event.
    beforeSend(event) {
      if (event.request) {
        delete event.request.data;
        delete event.request.cookies;
        if (event.request.headers) {
          for (const h of Object.keys(event.request.headers)) {
            if (SENSITIVE_KEY_PATTERN.test(h)) delete event.request.headers[h];
          }
        }
      }
      // Keep only a non-identifying user reference (id set by our filter).
      if (event.user) {
        event.user = event.user.id ? { id: event.user.id } : undefined;
      }
      if (event.contexts) event.contexts = scrub(event.contexts) as typeof event.contexts;
      if (event.extra) event.extra = scrub(event.extra) as typeof event.extra;
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.map((b) => ({
          ...b,
          data: b.data ? (scrub(b.data) as typeof b.data) : b.data,
        }));
      }
      return event;
    },
  });
}
