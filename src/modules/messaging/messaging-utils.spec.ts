import { messagingWorker, sendingAvailable } from './messaging-env.util';
import { createHmac } from 'crypto';
import {
  inboundIntent,
  nextStatus,
  replaceableBy,
  verifyMetaSignature,
} from './message-status.util';
import { classifyMetaError, nextAttemptDelayMs } from './meta-error-map';
import { deferUntil, zonedPeriod } from './quiet-hours.util';
import {
  decryptToken,
  encryptToken,
  maskToken,
  messagingKey,
} from './token-crypto.util';
import {
  bodyParameters,
  cleanParam,
  TEMPLATES,
  templateForEvent,
} from './templates/template-registry';
import { MESSAGE_EVENTS } from './messaging.constants';
import { formatRupees } from '../../common/utils/money.util';

describe('webhook signature', () => {
  const secret = 'app-secret';
  const body = Buffer.from('{"entry":[]}');
  const good =
    'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  it('accepts the HMAC of the raw body', () => {
    expect(verifyMetaSignature(body, good, secret)).toBe(true);
  });
  it('rejects a wrong signature, a wrong secret, a missing header or no secret', () => {
    expect(verifyMetaSignature(body, good.replace(/.$/, '0'), secret)).toBe(
      false,
    );
    expect(verifyMetaSignature(body, good, 'other')).toBe(false);
    expect(verifyMetaSignature(body, undefined, secret)).toBe(false);
    expect(verifyMetaSignature(body, 'sha256=zz', secret)).toBe(false);
    expect(verifyMetaSignature(body, good, '')).toBe(false);
  });
  it('rejects a body that changed after signing', () => {
    expect(
      verifyMetaSignature(Buffer.from('{"entry":[1]}'), good, secret),
    ).toBe(false);
  });
});

describe('status ordering', () => {
  it('moves forward only: sent < delivered < read', () => {
    expect(nextStatus('sent', 'delivered')).toBe('delivered');
    expect(nextStatus('delivered', 'read')).toBe('read');
    expect(nextStatus('sent', 'read')).toBe('read');
    expect(nextStatus('read', 'delivered')).toBeNull();
    expect(nextStatus('delivered', 'sent')).toBeNull();
    expect(nextStatus('read', 'read')).toBeNull();
  });
  it('failed wins over anything not yet read; nothing leaves a final state', () => {
    expect(nextStatus('sent', 'failed')).toBe('failed');
    expect(nextStatus('delivered', 'failed')).toBe('failed');
    expect(nextStatus('read', 'failed')).toBeNull();
    expect(nextStatus('failed', 'delivered')).toBeNull();
    expect(nextStatus('cancelled', 'sent')).toBeNull();
    expect(nextStatus('skipped', 'sent')).toBeNull();
  });
  it('replaceableBy lists the statuses an update may overwrite', () => {
    expect(replaceableBy('read').sort()).toEqual(
      ['delivered', 'queued', 'sending', 'sent'].sort(),
    );
    expect(replaceableBy('delivered').sort()).toEqual(
      ['queued', 'sending', 'sent'].sort(),
    );
  });
  it('STOP and UNSUBSCRIBE in any case opt out; START opts back in', () => {
    expect(inboundIntent('STOP')).toBe('stop');
    expect(inboundIntent('  unsubscribe ')).toBe('stop');
    expect(inboundIntent('Stop')).toBe('stop');
    expect(inboundIntent('start')).toBe('start');
    expect(inboundIntent('please stop sending')).toBeNull();
  });
});

describe('Meta error classification', () => {
  it('retries rate limits, 5xx and network trouble', () => {
    expect(classifyMetaError({ code: 130429, httpStatus: 400 }).retryable).toBe(
      true,
    );
    expect(classifyMetaError({ code: null, httpStatus: 503 }).retryable).toBe(
      true,
    );
    expect(classifyMetaError({ code: null, httpStatus: null }).retryable).toBe(
      true,
    );
    expect(classifyMetaError({ code: 131048, httpStatus: 400 }).retryable).toBe(
      true,
    );
  });
  it('fails at once on undeliverable, template and parameter errors', () => {
    const undeliverable = classifyMetaError({ code: 131026, httpStatus: 400 });
    expect(undeliverable).toMatchObject({
      retryable: false,
      clearsVerification: true,
    });
    expect(classifyMetaError({ code: 132001, httpStatus: 404 }).retryable).toBe(
      false,
    );
    expect(classifyMetaError({ code: 132000, httpStatus: 400 }).retryable).toBe(
      false,
    );
    expect(classifyMetaError({ code: 131009, httpStatus: 400 }).retryable).toBe(
      false,
    );
    expect(classifyMetaError({ code: 999999, httpStatus: 400 }).retryable).toBe(
      false,
    );
  });
  it("knows the codes on Meta's reference as of Nov 2026", () => {
    expect(classifyMetaError({ code: 131037, httpStatus: 400 })).toMatchObject({
      retryable: false,
      reason: 'The sending number has no approved display name yet',
    });
    expect(classifyMetaError({ code: 130403, httpStatus: 400 }).retryable).toBe(
      false,
    );
    expect(classifyMetaError({ code: 132018, httpStatus: 400 }).retryable).toBe(
      false,
    );
    expect(classifyMetaError({ code: 0, httpStatus: 401 }).retryable).toBe(
      false,
    );
    expect(classifyMetaError({ code: 131057, httpStatus: 400 }).retryable).toBe(
      true,
    );
  });
  it("names the test number's allow-list error in plain words", () => {
    expect(classifyMetaError({ code: 131030, httpStatus: 400 })).toMatchObject({
      retryable: false,
      reason:
        "This number is not on the test number's recipient list (add it in Meta's API Setup)",
    });
  });
  it('treats the 200-299 range as a missing permission', () => {
    expect(classifyMetaError({ code: 250, httpStatus: 403 })).toMatchObject({
      retryable: false,
      reason: 'The WhatsApp app is missing a permission',
    });
  });
  it('leaves code 1 to the HTTP status', () => {
    expect(classifyMetaError({ code: 1, httpStatus: 500 }).retryable).toBe(
      true,
    );
    expect(classifyMetaError({ code: 1, httpStatus: 400 }).retryable).toBe(
      false,
    );
  });
  it('backs off 2^attempts minutes', () => {
    expect(nextAttemptDelayMs(1)).toBe(2 * 60_000);
    expect(nextAttemptDelayMs(3)).toBe(8 * 60_000);
  });
});

describe('quiet hours (Asia/Karachi is UTC+5)', () => {
  const tz = 'Asia/Karachi';
  const win = { start: '21:00', end: '09:00' };

  it('evening: defers to 09:00 PKT next morning', () => {
    const now = new Date('2026-11-05T17:30:00Z'); // 22:30 PKT
    expect(deferUntil(now, tz, win)?.toISOString()).toBe(
      '2026-11-06T04:00:00.000Z',
    );
  });
  it('after midnight: defers to 09:00 PKT the same day', () => {
    const now = new Date('2026-11-05T21:00:00Z'); // 02:00 PKT on the 6th
    expect(deferUntil(now, tz, win)?.toISOString()).toBe(
      '2026-11-06T04:00:00.000Z',
    );
  });
  it('daytime: sends now', () => {
    expect(deferUntil(new Date('2026-11-05T09:00:00Z'), tz, win)).toBeNull(); // 14:00 PKT
    expect(deferUntil(new Date('2026-11-05T04:00:00Z'), tz, win)).toBeNull(); // 09:00 PKT exactly
  });
  it('a same-day window and no window', () => {
    const now = new Date('2026-11-05T08:00:00Z'); // 13:00 PKT
    expect(
      deferUntil(now, tz, { start: '12:00', end: '14:00' })?.toISOString(),
    ).toBe('2026-11-05T09:00:00.000Z');
    expect(deferUntil(now, tz, null)).toBeNull();
    expect(deferUntil(now, tz, { start: '09:00', end: '09:00' })).toBeNull();
    expect(deferUntil(now, tz, { start: 'bad', end: '09:00' })).toBeNull();
  });
  it('usage period is the company-time month', () => {
    expect(zonedPeriod(new Date('2026-11-30T20:00:00Z'), tz)).toBe('2026-12'); // 01:00 PKT 1 Dec
  });
});

describe('access token encryption', () => {
  const key = messagingKey(Buffer.alloc(32, 7).toString('base64'))!;
  it('round-trips and masks', () => {
    const enc = encryptToken('EAAG-secret-1234', key);
    expect(enc.startsWith('v1:')).toBe(true);
    expect(enc).not.toContain('secret');
    expect(decryptToken(enc, key)).toBe('EAAG-secret-1234');
    expect(maskToken('EAAG-secret-1234')).toBe('••••1234');
  });
  it('a wrong key or a tampered value does not decrypt', () => {
    const enc = encryptToken('t', key);
    expect(
      decryptToken(enc, messagingKey(Buffer.alloc(32, 8).toString('base64'))),
    ).toBeNull();
    expect(decryptToken(enc.slice(0, -2) + 'AA', key)).toBeNull();
  });
  it('only a 32-byte base64 key is a key', () => {
    expect(messagingKey('short')).toBeNull();
    expect(messagingKey('')).toBeNull();
  });
});

describe('templates', () => {
  it('every event has a UTILITY template in English and Urdu, naming the company first', () => {
    for (const e of [...MESSAGE_EVENTS, 'test' as const]) {
      const t = templateForEvent(e);
      expect(t.category).toBe('UTILITY');
      expect(t.params[0]).toBe('company');
      expect(t.footer).toBe('Sent via FinMatrix');
      expect(t.text.en.body).toContain('{{1}}');
      expect(t.text.ur.body).toContain('{{1}}');
      for (const k of t.params) expect(t.example[k]).toBeTruthy();
    }
    expect(TEMPLATES).toHaveLength(13);
  });
  it('placeholders match the parameter count', () => {
    for (const t of TEMPLATES) {
      for (const lang of ['en', 'ur'] as const) {
        const nums = [...t.text[lang].body.matchAll(/\{\{(\d+)\}\}/g)].map(
          (m) => Number(m[1]),
        );
        expect(Math.max(...nums)).toBe(t.params.length);
      }
    }
  });
  it('cleans values WhatsApp would refuse', () => {
    expect(cleanParam('')).toBe('-');
    expect(cleanParam('a\nb\tc')).toBe('a b c');
    expect(cleanParam('a      b')).toBe('a   b');
    expect(
      bodyParameters(templateForEvent('po_cancelled'), {
        company: 'X',
        recipientName: 'Y',
        poNumber: 'PO-1',
      }),
    ).toEqual(['X', 'Y', 'PO-1']);
  });
});

describe('formatRupees', () => {
  it('formats with Decimal, two places and grouping', () => {
    expect(formatRupees('1234567.5')).toBe('Rs 1,234,567.50');
    expect(formatRupees('0.005')).toBe('Rs 0.01');
    expect(formatRupees('-80')).toBe('-Rs 80.00');
    expect(formatRupees(null)).toBe('Rs 0.00');
  });
});

/**
 * Meta's template rules, as its API enforced them on 5 Nov 2026:
 * - 2388299 "Variables can't be at the start or end of the template";
 * - 2388293 "too many variables for its length": it accepted 12 words for 5
 *   variables and refused 10 for 5 and 6 for 4, so keep more than 2 words of
 *   text per variable.
 */
describe("every template passes Meta's body rules (both languages)", () => {
  const words = (body: string) =>
    body
      .replace(/\{\{\d+\}\}/g, ' ')
      .split(/[\s،,.:;!?()۔-]+/u)
      .filter(Boolean).length;
  for (const t of TEMPLATES) {
    for (const lang of ['en', 'ur'] as const) {
      const body = t.text[lang].body;
      it(`${t.name}/${lang}`, () => {
        expect(body.trim()).not.toMatch(/^\{\{\d+\}\}/);
        expect(body.trim()).not.toMatch(/\{\{\d+\}\}[\s.،۔!?:;)]*$/u);
        const vars = (body.match(/\{\{\d+\}\}/g) ?? []).length;
        if (vars > 0) expect(words(body) / vars).toBeGreaterThan(2);
      });
    }
  }
});

describe('the simulated sender never runs on a production server', () => {
  const keys = [
    'NODE_ENV',
    'DYNO',
    'WHATSAPP_ENABLED',
    'MESSAGING_WORKER_ENABLED',
  ];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    for (const k of keys) delete process.env[k];
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('development and tests may simulate', () => {
    process.env.NODE_ENV = 'development';
    expect(sendingAvailable(null)).toBe(true);
    expect(messagingWorker(null)).toBe(true);
  });

  it('production without WHATSAPP_ENABLED: nothing may send, the worker idles', () => {
    process.env.NODE_ENV = 'production';
    expect(sendingAvailable(null)).toBe(false);
    expect(messagingWorker(null)).toBe(false);
  });

  it('a Heroku dyno counts as production even without NODE_ENV', () => {
    process.env.DYNO = 'web.1';
    expect(sendingAvailable(null)).toBe(false);
  });

  it('production with WHATSAPP_ENABLED=true sends for real', () => {
    process.env.NODE_ENV = 'production';
    process.env.WHATSAPP_ENABLED = 'true';
    expect(sendingAvailable(null)).toBe(true);
    expect(messagingWorker(null)).toBe(true);
  });
});
