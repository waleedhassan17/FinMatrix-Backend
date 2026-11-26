import { canTransition, DEMO_TRANSITIONS } from './demo-state';
import {
  allSlots,
  checkFormToken,
  isBookableSlot,
  issueFormToken,
  pktDate,
  pktTime,
} from './demo-slots';
import { buildDemoIcs } from './ics';

describe('demo pipeline', () => {
  it('follows new → contacted → scheduled → completed → converted', () => {
    expect(canTransition('new', 'contacted')).toBe(true);
    expect(canTransition('contacted', 'scheduled')).toBe(true);
    expect(canTransition('scheduled', 'completed')).toBe(true);
    expect(canTransition('completed', 'converted')).toBe(true);
  });
  it('allows reschedule loops and no-shows, never leaves a final state', () => {
    expect(canTransition('scheduled', 'rescheduled')).toBe(true);
    expect(canTransition('rescheduled', 'scheduled')).toBe(true);
    expect(canTransition('no_show', 'rescheduled')).toBe(true);
    expect(DEMO_TRANSITIONS.converted).toEqual([]);
    expect(DEMO_TRANSITIONS.lost).toEqual([]);
    expect(canTransition('new', 'completed')).toBe(false);
  });
});

describe('demo slots (Asia/Karachi)', () => {
  const saved = { ...process.env };
  afterEach(() => (process.env = { ...saved }));

  it('Mon–Sat, 10:00–18:00 PKT, 30 minutes, from tomorrow, 14 days', () => {
    // Thursday 26 Nov 2026, 23:30 PKT (18:30 UTC).
    const now = new Date('2026-11-26T18:30:00Z');
    const slots = allSlots(now);
    expect(pktDate(slots[0])).toBe('2026-11-27');
    expect(pktTime(slots[0])).toBe('10:00');
    expect(pktTime(slots[15])).toBe('17:30');
    // 14 days minus 2 Sundays = 12 days × 16 slots.
    expect(slots.length).toBe(12 * 16);
    const sundays = slots.filter(
      (s) => new Date(s.getTime() + 5 * 3600_000).getUTCDay() === 0,
    );
    expect(sundays).toEqual([]);
    expect(isBookableSlot(slots[3], now)).toBe(true);
    expect(isBookableSlot(new Date(slots[3].getTime() + 60_000), now)).toBe(
      false,
    );
  });

  it('follows the slot settings', () => {
    process.env.DEMO_SLOT_DAY_START = '09:00';
    process.env.DEMO_SLOT_DAY_END = '10:00';
    process.env.DEMO_SLOT_MINUTES = '60';
    process.env.DEMO_SLOT_DAYS_AHEAD = '1';
    process.env.DEMO_SLOT_WEEKDAYS = '1,2,3,4,5,6,7';
    const slots = allSlots(new Date('2026-11-26T03:00:00Z'));
    expect(slots.map((s) => s.toISOString())).toEqual([
      '2026-11-27T04:00:00.000Z',
    ]);
  });
});

describe('demo form token', () => {
  it('needs 3 seconds, rejects forgeries and stale forms', () => {
    const t0 = 1_800_000_000_000;
    const token = issueFormToken(t0);
    expect(checkFormToken(token, t0 + 1000)).toBe('too_fast');
    expect(checkFormToken(token, t0 + 3500)).toBe('ok');
    expect(checkFormToken(token, t0 + 7 * 3600_000)).toBe('invalid');
    expect(checkFormToken(`${t0}.forged`, t0 + 3500)).toBe('invalid');
    expect(checkFormToken(undefined)).toBe('invalid');
  });
});

describe('demo .ics', () => {
  it('is an RFC 5545 invite with CRLF lines folded at 75 octets', () => {
    const ics = buildDemoIcs({
      uid: 'demo-1@finmatrix',
      sequence: 2,
      start: new Date('2026-12-01T06:00:00Z'),
      minutes: 30,
      summary: 'FinMatrix demo — Ali Traders, Lahore; wholesale',
      description: 'Line one\nLine two '.repeat(10),
      location: 'https://meet.example.com/x',
      organizerEmail: 'support@example.com',
      attendeeEmail: 'a@example.com',
      attendeeName: 'Ali',
      method: 'REQUEST',
    });
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics).toContain('METHOD:REQUEST');
    expect(ics).toContain('SEQUENCE:2');
    expect(ics).toContain('DTSTART:20261201T060000Z');
    expect(ics).toContain('DTEND:20261201T063000Z');
    expect(ics).toContain(
      'SUMMARY:FinMatrix demo — Ali Traders\\, Lahore\; wholesale',
    );
    for (const line of ics.split('\r\n')) {
      expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75);
    }
    const cancel = buildDemoIcs({
      uid: 'x',
      sequence: 1,
      start: new Date(),
      minutes: 30,
      summary: 's',
      description: 'd',
      organizerEmail: 'o@example.com',
      attendeeEmail: 'a@example.com',
      attendeeName: 'A',
      method: 'CANCEL',
    });
    expect(cancel).toContain('STATUS:CANCELLED');
  });
});
