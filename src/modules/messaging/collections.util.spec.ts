import {
  reminderTargets,
  statementWindow,
  zonedToday,
} from './collections.util';

describe('reminderTargets', () => {
  it('maps the schedule to due dates for today', () => {
    const t = reminderTargets('2026-11-05', {
      beforeDue: [3],
      afterDue: [0, 7, 15, 30],
    });
    expect(t).toEqual([
      { dueDate: '2026-11-08', offset: -3, event: 'reminder_upcoming' },
      { dueDate: '2026-11-05', offset: 0, event: 'reminder_overdue' },
      { dueDate: '2026-10-29', offset: 7, event: 'reminder_overdue' },
      { dueDate: '2026-10-21', offset: 15, event: 'reminder_overdue' },
      { dueDate: '2026-10-06', offset: 30, event: 'reminder_overdue' },
    ]);
  });

  it('ignores nonsense and duplicates', () => {
    expect(
      reminderTargets('2026-11-05', {
        beforeDue: [0, -2, 3, 3],
        afterDue: [-1, 1.5],
      }),
    ).toEqual([
      { dueDate: '2026-11-08', offset: -3, event: 'reminder_upcoming' },
    ]);
  });
});

describe('zonedToday', () => {
  it('is the company-time date', () => {
    expect(zonedToday(new Date('2026-11-05T20:30:00Z'), 'Asia/Karachi')).toBe(
      '2026-11-06',
    ); // 01:30 PKT
    expect(zonedToday(new Date('2026-11-05T18:30:00Z'), 'Asia/Karachi')).toBe(
      '2026-11-05',
    ); // 23:30 PKT
  });
});

describe('statementWindow', () => {
  const tz = 'Asia/Karachi';
  it('opens on the 1st from 09:00 company time for the month just ended', () => {
    expect(statementWindow(new Date('2026-12-01T04:00:00Z'), tz)).toEqual({
      start: '2026-11-01',
      end: '2026-11-30',
      label: 'November 2026',
      version: 202611,
    });
  });
  it('January covers December of the year before', () => {
    expect(statementWindow(new Date('2027-01-01T05:00:00Z'), tz)).toMatchObject(
      {
        start: '2026-12-01',
        end: '2026-12-31',
        version: 202612,
      },
    );
  });
  it('is closed before 09:00 and on other days', () => {
    expect(statementWindow(new Date('2026-12-01T03:59:00Z'), tz)).toBeNull(); // 08:59 PKT
    expect(statementWindow(new Date('2026-12-02T05:00:00Z'), tz)).toBeNull();
  });
});
