import { createHmac, timingSafeEqual } from 'crypto';
import { MessageStatus, STATUS_RANK } from './messaging.constants';

/**
 * Statuses only move forward: sent < delivered < read. 'failed' wins over any
 * not-yet-read state (Meta can report failed after sent). Nothing moves a
 * message out of read, failed, skipped or cancelled. Returns the status to
 * store, or null to leave the row as it is (the event is still recorded).
 */
export function nextStatus(
  current: MessageStatus,
  incoming: MessageStatus,
): MessageStatus | null {
  if (
    current === 'read' ||
    current === 'failed' ||
    current === 'skipped' ||
    current === 'cancelled'
  )
    return null;
  if (incoming === 'failed') return 'failed';
  if (!['sent', 'delivered', 'read'].includes(incoming)) return null;
  return STATUS_RANK[incoming] > STATUS_RANK[current] ? incoming : null;
}

/** The statuses `incoming` may replace (for a conditional UPDATE). */
export function replaceableBy(incoming: MessageStatus): MessageStatus[] {
  const all: MessageStatus[] = [
    'queued',
    'sending',
    'sent',
    'delivered',
    'read',
    'failed',
    'skipped',
    'cancelled',
  ];
  return all.filter((s) => nextStatus(s, incoming) === incoming);
}

/**
 * X-Hub-Signature-256 check: `sha256=<hex HMAC-SHA256 of the raw body>` with
 * the app secret. Constant-time compare; any malformed input is a mismatch.
 * No secret configured means nothing verifies.
 */
export function verifyMetaSignature(
  rawBody: Buffer | string | null | undefined,
  header: string | string[] | null | undefined,
  appSecret: string | null | undefined,
): boolean {
  if (!appSecret || !rawBody || !header) return false;
  const value = Array.isArray(header) ? header[0] : header;
  const m = /^sha256=([0-9a-f]{64})$/i.exec((value ?? '').trim());
  if (!m) return false;
  const expected = createHmac('sha256', appSecret)
    .update(typeof rawBody === 'string' ? Buffer.from(rawBody) : rawBody)
    .digest();
  const given = Buffer.from(m[1], 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Inbound text that withdraws (STOP) or restores (START) consent. */
export function inboundIntent(
  text: string | null | undefined,
): 'stop' | 'start' | null {
  const t = (text ?? '').trim().toLowerCase();
  if (t === 'stop' || t === 'unsubscribe') return 'stop';
  if (t === 'start' || t === 'subscribe') return 'start';
  return null;
}
