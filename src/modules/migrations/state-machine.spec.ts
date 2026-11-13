import { EntityManager } from 'typeorm';
import {
  assertTransition,
  canTransition,
  lockEditable,
  sourcesOf,
  stepFor,
  transitionAtomically,
} from './state-machine';

describe('migration state machine', () => {
  it('follows the documented path and nothing else', () => {
    expect(canTransition('draft', 'uploaded')).toBe(true);
    expect(canTransition('uploaded', 'mapped')).toBe(true);
    expect(canTransition('mapped', 'validated')).toBe(true);
    expect(canTransition('validated', 'ready')).toBe(true);
    expect(canTransition('ready', 'committed')).toBe(true);
    expect(canTransition('committed', 'closed')).toBe(true);
    expect(canTransition('committed', 'rolled_back')).toBe(true);

    expect(canTransition('draft', 'committed')).toBe(false);
    expect(canTransition('mapped', 'committed')).toBe(false);
    expect(canTransition('validated', 'committed')).toBe(false);
    expect(canTransition('closed', 'rolled_back')).toBe(false);
    expect(canTransition('rolled_back', 'committed')).toBe(false);
    expect(canTransition('committed', 'mapped')).toBe(false);
  });

  it('sends any fix back to mapped', () => {
    for (const from of ['mapped', 'validated', 'ready'] as const) {
      expect(canTransition(from, 'mapped')).toBe(true);
      expect(canTransition(from, 'uploaded')).toBe(true);
    }
  });

  it('refuses with the documented code', () => {
    expect(() => assertTransition('mapped', 'committed')).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({
          code: 'MIGRATION_INVALID_TRANSITION',
        }),
      }),
    );
    expect(() => assertTransition('ready', 'committed')).not.toThrow();
  });

  it('maps statuses to the seven wizard steps', () => {
    expect(stepFor('draft', false)).toBe(1);
    expect(stepFor('uploaded', false)).toBe(2);
    expect(stepFor('mapped', false)).toBe(3);
    expect(stepFor('mapped', true)).toBe(4);
    expect(stepFor('validated', false)).toBe(5);
    expect(stepFor('ready', false)).toBe(6);
    expect(stepFor('committed', false)).toBe(7);
    expect(stepFor('rolled_back', false)).toBe(7);
  });
});

describe('atomic transitions', () => {
  const batch = { id: 'b1', companyId: 'c1' };
  const em = (affected: number, now: string | null) =>
    ({
      update: jest.fn(async () => ({ affected })),
      findOne: jest.fn(async () => (now ? { id: 'b1', status: now } : null)),
    }) as unknown as EntityManager & {
      update: jest.Mock;
      findOne: jest.Mock;
    };

  it('lists the statuses a transition may start from', () => {
    expect(sourcesOf('committed')).toEqual(['ready']);
    expect(sourcesOf('closed')).toEqual(['committed']);
    expect(sourcesOf('rolled_back')).toEqual(['committed']);
    expect(sourcesOf('uploaded', { editableOnly: true }).sort()).toEqual(
      ['draft', 'mapped', 'ready', 'uploaded', 'validated'].sort(),
    );
  });

  it('writes the status and the changes in one conditional update', async () => {
    const m = em(1, null);
    await transitionAtomically(
      m,
      batch,
      'closed',
      { closedAt: new Date(0) } as never,
      {
        from: ['committed'],
      },
    );
    const [, where, set] = m.update.mock.calls[0];
    expect(where).toMatchObject({ id: 'b1', companyId: 'c1' });
    expect(JSON.stringify(where.status)).toContain('committed');
    expect(set).toMatchObject({ status: 'closed' });
    expect(m.findOne).not.toHaveBeenCalled();
  });

  it('refuses with 409 when another request moved the batch first', async () => {
    await expect(
      transitionAtomically(
        em(0, 'rolled_back'),
        batch,
        'closed',
        {},
        { from: ['committed'] },
      ),
    ).rejects.toMatchObject({
      response: { code: 'MIGRATION_INVALID_TRANSITION' },
    });
    await expect(
      transitionAtomically(
        em(0, 'committed'),
        batch,
        'uploaded',
        {},
        { editableOnly: true },
      ),
    ).rejects.toMatchObject({
      response: { code: 'MIGRATION_INVALID_TRANSITION' },
    });
    // Allowed by the table, but not from the status the caller required.
    await expect(
      transitionAtomically(
        em(0, 'mapped'),
        batch,
        'ready',
        {},
        { from: ['ready'] },
      ),
    ).rejects.toMatchObject({
      response: { code: 'MIGRATION_INVALID_TRANSITION' },
    });
    await expect(
      transitionAtomically(
        em(0, null),
        batch,
        'closed',
        {},
        { from: ['committed'] },
      ),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND' } });
  });

  it('locks the row and refuses to edit a committed batch', async () => {
    const m = {
      findOne: jest.fn(async () => ({ id: 'b1', status: 'committed' })),
    } as unknown as EntityManager & { findOne: jest.Mock };
    await expect(lockEditable(m, 'c1', 'b1')).rejects.toMatchObject({
      response: { code: 'MIGRATION_INVALID_TRANSITION' },
    });
    expect(m.findOne.mock.calls[0][1]).toMatchObject({
      lock: { mode: 'pessimistic_write' },
    });
  });
});
