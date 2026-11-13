import { assertTransition, canTransition, stepFor } from './state-machine';

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
