/**
 * Meta WhatsApp Cloud API error codes -> what the dispatcher does next.
 *
 * Checked against Meta's error reference on 5 Nov 2026
 * (developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes).
 * Meta adds codes over time, so re-check this list when moving to a new Graph
 * API version. An unknown code falls back to the HTTP status: 5xx, 429 and
 * network errors retry, any other 4xx does not.
 */

export interface ErrorClass {
  retryable: boolean;
  /** Plain words for the timeline. */
  reason: string;
  /** The number cannot receive WhatsApp: clear whatsapp_verified_at. */
  clearsVerification?: boolean;
}

// Code 1 ("invalid request or possible server error") is deliberately absent:
// it is decided by the HTTP status, so a 5xx retries and a 4xx does not.
const RETRYABLE: Record<number, string> = {
  2: 'WhatsApp service temporarily unavailable',
  4: 'Too many requests for this app; will retry',
  80007: 'WhatsApp Business Account rate limit; will retry',
  130429: 'Rate limit reached; will retry',
  131000: 'WhatsApp had a temporary problem',
  131016: 'WhatsApp service temporarily unavailable',
  131048:
    'WhatsApp is limiting sends because earlier messages were blocked or reported; will retry',
  131056: 'Too many messages to this number in a short time; will retry',
  131057: 'The WhatsApp Business account is in maintenance; will retry',
  133004: 'WhatsApp server temporarily unavailable',
};

const MISSING_PERMISSION: ErrorClass = {
  retryable: false,
  reason: 'The WhatsApp app is missing a permission',
};

const PERMANENT: Record<number, ErrorClass> = {
  0: {
    retryable: false,
    reason:
      'WhatsApp could not authenticate the app (token expired or revoked)',
  },
  3: MISSING_PERMISSION,
  10: MISSING_PERMISSION,
  33: {
    retryable: false,
    reason: 'The sending phone number was deleted from WhatsApp',
  },
  100: {
    retryable: false,
    reason: 'WhatsApp rejected a parameter of the message',
  },
  190: { retryable: false, reason: 'WhatsApp access token expired or invalid' },
  368: {
    retryable: false,
    reason:
      'The WhatsApp Business account is restricted for a policy violation',
  },
  130403: {
    retryable: false,
    reason: 'This contact has blocked the sender on WhatsApp',
  },
  130472: {
    retryable: false,
    reason: 'WhatsApp held this message back as part of an experiment',
  },
  130497: {
    retryable: false,
    reason: 'This account may not message numbers in that country',
  },
  131005: MISSING_PERMISSION,
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
  // Meta's free test number only: the recipient must be on its allow list.
  131030: {
    retryable: false,
    reason:
      "This number is not on the test number's recipient list (add it in Meta's API Setup)",
  },
  131031: {
    retryable: false,
    reason:
      'The WhatsApp Business account is restricted; check its status in WhatsApp Manager',
  },
  131037: {
    retryable: false,
    reason: 'The sending number has no approved display name yet',
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
  131049: {
    retryable: false,
    reason:
      'WhatsApp held this back to protect engagement; try again after 24 hours',
  },
  131050: {
    retryable: false,
    reason: 'This contact has stopped marketing messages',
  },
  131051: { retryable: false, reason: 'Message type not supported' },
  131053: { retryable: false, reason: 'WhatsApp could not accept the PDF' },
  131063: {
    retryable: false,
    reason: 'Marketing messages are switched off for this account',
  },
  131064: {
    retryable: false,
    reason:
      'WhatsApp is limiting messages over template categories; review the templates in WhatsApp Manager',
  },
  132000: {
    retryable: false,
    reason:
      'The number of template values does not match the approved template',
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
    reason: 'WhatsApp rejected the template content under its policies',
  },
  132012: { retryable: false, reason: 'A template value has the wrong format' },
  132015: {
    retryable: false,
    reason: 'Template paused by WhatsApp for low quality',
  },
  132016: { retryable: false, reason: 'Template disabled by WhatsApp' },
  132018: { retryable: false, reason: 'A template value was not valid' },
  133010: {
    retryable: false,
    reason: 'The sending number is not registered with WhatsApp',
  },
  135000: {
    retryable: false,
    reason: 'WhatsApp rejected the request parameters',
  },
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
    // 200-299: a permission was never granted or was removed.
    if (code >= 200 && code <= 299) return MISSING_PERMISSION;
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
