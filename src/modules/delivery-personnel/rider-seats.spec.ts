import { planRiderSeats, type SeatCandidate } from './rider-seats';

const rider = (
  userId: string,
  day: number,
  opts: Partial<Pick<SeatCandidate, 'status' | 'hasOpenDelivery'>> = {},
): SeatCandidate => ({
  userId,
  status: opts.status ?? 'active',
  hasOpenDelivery: opts.hasOpenDelivery ?? false,
  createdAt: new Date(Date.UTC(2026, 0, day)),
});

describe('planRiderSeats', () => {
  it('changes nothing when the company is within its limit', () => {
    expect(planRiderSeats([rider('a', 1), rider('b', 2)], 3)).toEqual({ lock: [], unlock: [] });
  });

  it('locks the newest riders beyond the limit', () => {
    const plan = planRiderSeats(
      [rider('e', 5), rider('a', 1), rider('d', 4), rider('b', 2), rider('c', 3)],
      3,
    );
    expect(plan.lock.sort()).toEqual(['d', 'e']);
    expect(plan.unlock).toEqual([]);
  });

  it('keeps a rider with a delivery on the road even if they are the newest', () => {
    const plan = planRiderSeats(
      [rider('a', 1), rider('b', 2), rider('c', 3), rider('new', 9, { hasOpenDelivery: true })],
      3,
    );
    expect(plan.lock).toEqual(['c']);
  });

  it('restores locked riders when the limit goes back up', () => {
    const plan = planRiderSeats(
      [
        rider('a', 1),
        rider('b', 2),
        rider('c', 3),
        rider('d', 4, { status: 'plan_locked' }),
        rider('e', 5, { status: 'plan_locked' }),
      ],
      4,
    );
    expect(plan).toEqual({ lock: [], unlock: ['d'] });
  });

  it('can lock and unlock in one pass (an in-flight locked rider outranks an idle active one)', () => {
    const plan = planRiderSeats(
      [rider('a', 1), rider('b', 2), rider('late', 3, { status: 'plan_locked', hasOpenDelivery: true })],
      2,
    );
    expect(plan).toEqual({ lock: ['b'], unlock: ['late'] });
  });

  it('breaks ties on id so the outcome never depends on row order', () => {
    const one = planRiderSeats([rider('b', 1), rider('a', 1)], 1);
    const two = planRiderSeats([rider('a', 1), rider('b', 1)], 1);
    expect(one).toEqual({ lock: ['b'], unlock: [] });
    expect(two).toEqual(one);
  });

  it('treats a zero or negative limit as no seats', () => {
    expect(planRiderSeats([rider('a', 1)], 0).lock).toEqual(['a']);
    expect(planRiderSeats([rider('a', 1)], -1).lock).toEqual(['a']);
  });
});
