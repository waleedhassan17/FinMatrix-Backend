/**
 * Request-log redaction for signed links.
 *
 * A finished company backup is fetched through a public route whose
 * `?token=` query is the whole authorisation. pino-http logs every request's
 * URL and query, so without this the token of every backup download would
 * sit in the log store for anyone who can read logs. The standard serializer
 * runs first (pino-http wraps ours around it); this replaces the token
 * wherever it appears and leaves everything else as it was.
 */

export const REDACTED = '[redacted]';

export function redactTokenInUrl(url: unknown): unknown {
  if (typeof url !== 'string') return url;
  return url.replace(/([?&]token=)[^&#]*/gi, `$1${REDACTED}`);
}

export function redactTokenInQuery(query: unknown): unknown {
  if (!query || typeof query !== 'object') return query;
  const q = query as Record<string, unknown>;
  if (!('token' in q)) return query;
  return { ...q, token: REDACTED };
}

/** A pino `serializers.req` entry: receives the already-serialized request. */
export function redactingRequestSerializer<T extends Record<string, unknown>>(
  req: T,
): T {
  if (!req || typeof req !== 'object') return req;
  return {
    ...req,
    url: redactTokenInUrl(req.url),
    query: redactTokenInQuery(req.query),
  };
}
