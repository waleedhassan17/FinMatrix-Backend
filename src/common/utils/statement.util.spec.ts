import { inPeriod, statementBalances } from './statement.util';

describe('statementBalances', () => {
  const moves = [
    { date: '2026-01-10', amount: '1000' }, // invoice before the period
    { date: '2026-01-20', amount: '-400' }, // payment before the period
    { date: '2026-02-01', amount: '500' }, // invoice on the first day
    { date: '2026-02-14', amount: '-150' }, // credit memo inside
    { date: '2026-02-20', amount: '50' }, // refund of that credit, inside
    { date: '2026-02-28', amount: '-200' }, // payment on the last day
    { date: '2026-03-05', amount: '999' }, // after the period: in neither
  ];

  it('opens with everything before the period and closes with what falls inside it', () => {
    const { opening, closing } = statementBalances(moves, '2026-02-01', '2026-02-28');
    expect(opening.toFixed(2)).toBe('600.00');
    expect(closing.toFixed(2)).toBe('800.00');
  });

  it('counts both ends of the period', () => {
    expect(inPeriod('2026-02-01', '2026-02-01', '2026-02-28')).toBe(true);
    expect(inPeriod('2026-02-28', '2026-02-28', '2026-02-28')).toBe(true);
    expect(inPeriod('2026-03-01', '2026-02-01', '2026-02-28')).toBe(false);
  });

  it('reads a timestamp by its day', () => {
    const { closing } = statementBalances([{ date: '2026-02-28T23:10:00.000Z', amount: 5 }], '2026-02-01', '2026-02-28');
    expect(closing.toNumber()).toBe(5);
  });

  it('is zero for an account with nothing on it', () => {
    const { opening, closing } = statementBalances([], '2026-01-01', '2026-12-31');
    expect(opening.toNumber()).toBe(0);
    expect(closing.toNumber()).toBe(0);
  });
});
