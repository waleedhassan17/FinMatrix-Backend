/**
 * Meta WhatsApp Cloud API error codes -> what the dispatcher does next.
 *
 * !!! These codes MUST be re-checked against Meta's current error reference
 * (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes) before
 * WHATSAPP_ENABLED=true. Meta adds and renumbers codes; an unknown code falls
 * back to the HTTP status (5xx and network errors retry, 4xx does not).
 */

export interface ErrorClass {
  retryable: boolean;
  /** Plain words for the timeline. */
  reason: string;
  /** The number cannot receive WhatsApp: clear whatsapp_verified_at. */
  clearsVerification?: boolean;
}

const RETRYABLE: Record<number, string> = {
  1: 'WhatsApp had a temporary problem',
  2: 'WhatsApp service temporarily unavailable',
  4: 'Too many requests for this app; will retry',
  80007: 'WhatsApp Business Account rate limit; will retry',
  130429: 'Rate limit reached; will retry',
  131000: 'WhatsApp had a temporary problem',
  131016: 'WhatsApp service temporarily unavailable',
  131048: 'Spam rate limit reached; will retry',
  131056: 'Too many messages to this number; will retry',
  133004: 'WhatsApp server temporarily unavailable',
};

const PERMANENT: Record<number, ErrorClass> = {
  100: {
    retryable: false,
    reason: 'WhatsApp rejected a parameter of the message',
  },
  190: { retryable: false, reason: 'WhatsApp access token expired or invalid' },
  368: {
    retryable: false,
    reason: 'Sending temporarily blocked by WhatsApp for policy reasons',
  },
  131008: { retryable: false, reason: 'A required template value was missing' },
  131009: { retryable: false, reason: 'A template value was not valid' },
  131021: {
    retryable: false,
    reason: 'Sender and recipient are the same number',
  },
  131026: {
    retryable: false,
    reason: 'This number cannot receive WhatsApp messages',
    clearsVerification: true,
  },
  131031: {
    retryable: false,
    reason: 'The WhatsApp Business account is locked',
  },
  131042: {
    retryable: false,
    reason: 'WhatsApp billing problem on the business account',
  },
  131045: { retryable: false, reason: 'The sending number is not registered' },
  131047: {
    retryable: false,
    reason: 'Outside the 24-hour window (template required)',
  },
  131051: { retryable: false, reason: 'Message type not supported' },
  132000: {
    retryable: false,
    reason: 'Template values do not match the approved template',
  },
  132001: {
    retryable: false,
    reason: 'Template not found or not approved in this language',
  },
  132005: {
    retryable: false,
    reason: 'Template text too long after filling in values',
  },
  132007: {
    retryable: false,
    reason: 'Template text breaks WhatsApp formatting rules',
  },
  132012: { retryable: false, reason: 'A template value has the wrong format' },
  132015: {
    retryable: false,
    reason: 'Template paused by WhatsApp for low quality',
  },
  132016: { retryable: false, reason: 'Template disabled by WhatsApp' },
};

export function classifyMetaError(input: {
  code?: number | string | null;
  httpStatus?: number | null;
  message?: string | null;
}): ErrorClass {
  const code =
    input.code === undefined || input.code === null ? null : Number(input.code);
  if (code !== null && !Number.isNaN(code)) {
    if (RETRYABLE[code]) return { retryable: true, reason: RETRYABLE[code] };
    if (PERMANENT[code]) return PERMANENT[code];
  }
  const status = input.httpStatus ?? null;
  if (status === null) {
    // No HTTP answer at all: network trouble, try again later.
    return {
      retryable: true,
      reason: input.message || 'Could not reach WhatsApp; will retry',
    };
  }
  if (status >= 500 || status === 429) {
    return {
      retryable: true,
      reason: `WhatsApp answered ${status}; will retry`,
    };
  }
  return {
    retryable: false,
    reason: input.message || `WhatsApp refused the message (${status})`,
  };
}

/** What a provider throws. `code` is Meta's error code when there is one. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: number | string | null = null,
    readonly httpStatus: number | null = null,
    readonly details: unknown = null,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Exponential backoff: 2^attempts minutes after the attempt that failed. */
export function nextAttemptDelayMs(attemptsSoFar: number): number {
  return Math.pow(2, Math.max(1, attemptsSoFar)) * 60_000;
}
