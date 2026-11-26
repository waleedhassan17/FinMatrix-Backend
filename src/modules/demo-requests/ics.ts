/**
 * A minimal RFC 5545 calendar invite for a scheduled demo. Hand-built (no
 * dependency): one VEVENT, times in UTC, lines folded at 75 octets, text
 * escaped. METHOD:REQUEST adds or updates the event (SEQUENCE orders the
 * updates); METHOD:CANCEL removes it.
 */
export interface DemoIcsInput {
  uid: string;
  sequence: number;
  start: Date;
  minutes: number;
  summary: string;
  description: string;
  location?: string | null;
  organizerEmail: string;
  attendeeEmail: string;
  attendeeName: string;
  method: 'REQUEST' | 'CANCEL';
}

function utc(d: Date): string {
  return d
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function escapeText(v: string): string {
  return v
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** Fold a content line at 75 octets (continuation lines start with a space). */
function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let start = 0;
  let limit = 75;
  while (start < bytes.length) {
    let end = Math.min(start + limit, bytes.length);
    // never split a UTF-8 sequence
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
    parts.push(bytes.subarray(start, end).toString('utf8'));
    start = end;
    limit = 74; // the leading space counts
  }
  return parts.join('\r\n ');
}

export function buildDemoIcs(input: DemoIcsInput): string {
  const end = new Date(input.start.getTime() + input.minutes * 60_000);
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FinMatrix//Demo booking//EN',
    'CALSCALE:GREGORIAN',
    `METHOD:${input.method}`,
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `SEQUENCE:${input.sequence}`,
    `DTSTAMP:${utc(new Date())}`,
    `DTSTART:${utc(input.start)}`,
    `DTEND:${utc(end)}`,
    `SUMMARY:${escapeText(input.summary)}`,
    `DESCRIPTION:${escapeText(input.description)}`,
    ...(input.location ? [`LOCATION:${escapeText(input.location)}`] : []),
    `ORGANIZER;CN=FinMatrix:mailto:${input.organizerEmail}`,
    `ATTENDEE;CN=${escapeText(input.attendeeName)};ROLE=REQ-PARTICIPANT;RSVP=TRUE:mailto:${input.attendeeEmail}`,
    `STATUS:${input.method === 'CANCEL' ? 'CANCELLED' : 'CONFIRMED'}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ];
  return lines.map(fold).join('\r\n') + '\r\n';
}
