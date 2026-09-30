import {
  allocateRiderUsername,
  buildRiderUsernameBase,
  ensureRiderUsername,
  slugifyRiderName,
} from './rider-username';
// The REAL validator, not a copy. If the generator and the rule that accepts it
// ever drift, these fail — which is the whole point of importing it.
import { RIDER_USERNAME_REGEX } from './dto/delivery-personnel.dto';

/**
 * A rider signs in with a username and nothing else, so a name this module
 * refuses to produce is an account nobody can enter. Every case below asserts
 * the output against the validator the API applies.
 */
describe('rider username', () => {
  const ok = (u: string) => expect(u).toMatch(RIDER_USERNAME_REGEX);

  describe('slugifyRiderName', () => {
    it('folds accents rather than dropping the letter', () => {
      // "imranal" would be a name its owner does not recognise.
      expect(slugifyRiderName('Imran Alí')).toBe('imranali');
      expect(slugifyRiderName('Zoë')).toBe('zoe');
    });

    it('strips everything the rule does not allow', () => {
      expect(slugifyRiderName('Ali  Khan-7')).toBe('alikhan7');
      expect(slugifyRiderName('محمد')).toBe('');
    });

    it('survives null and undefined', () => {
      expect(slugifyRiderName(null)).toBe('');
      expect(slugifyRiderName(undefined)).toBe('');
    });
  });

  describe('buildRiderUsernameBase', () => {
    it('prefixes with the company code so two companies cannot collide', () => {
      // users.username is globally unique, so this is what keeps one company's
      // "imran" out of another's way.
      const u = buildRiderUsernameBase({ inviteCode: 'FM2024', displayName: 'Imran Khan' });
      expect(u).toBe('fm2024.imran');
      ok(u);
    });

    it('lowercases the invite code', () => {
      // The admin app sends an uppercase code; the rule is lowercase-only.
      ok(buildRiderUsernameBase({ inviteCode: 'ABCD99', displayName: 'Ali' }));
      expect(buildRiderUsernameBase({ inviteCode: 'ABCD99', displayName: 'Ali' }))
        .toBe('abcd99.ali');
    });

    it('takes the first token of a multi-part name', () => {
      expect(buildRiderUsernameBase({ inviteCode: 'fm', displayName: 'Saim Raza Khan' }))
        .toBe('fm.saim');
    });

    it('falls back to the email local part when there is no name', () => {
      const u = buildRiderUsernameBase({ inviteCode: 'fm', email: 'haseeb@metromatrix.com' });
      expect(u).toBe('fm.haseeb');
      ok(u);
    });

    it('falls back to "rider" when it has nothing to work with', () => {
      const u = buildRiderUsernameBase({});
      expect(u).toBe('rider.rider');
      ok(u);
    });

    it('still produces a legal name when the name is entirely unrepresentable', () => {
      // A Urdu-only display name slugs to '', which must not yield "fm." —
      // a trailing dot passes the character class but reads as a bug.
      const u = buildRiderUsernameBase({ inviteCode: 'fm', displayName: 'محمد' });
      ok(u);
      expect(u.endsWith('.')).toBe(false);
    });

    it('leaves room for a collision suffix inside varchar(64)', () => {
      const u = buildRiderUsernameBase({
        inviteCode: 'c'.repeat(40),
        displayName: 'n'.repeat(40),
      });
      expect(u.length).toBeLessThanOrEqual(58);
      ok(u);
      // …and the longest suffix we would ever append still fits the column.
      expect(`${u}1000`.length).toBeLessThanOrEqual(64);
      ok(`${u}1000`);
    });

    it('pads a base too short for the 3-character minimum', () => {
      const u = buildRiderUsernameBase({ inviteCode: 'a', displayName: '' });
      ok(u);
      expect(u.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('allocateRiderUsername', () => {
    /** A fake EntityManager whose `users` table holds `taken`. */
    const em = (taken: string[]) => ({
      query: jest.fn(async (_sql: string, params: unknown[]) =>
        taken.includes(String(params[0])) ? [{ '?column?': 1 }] : [],
      ),
    }) as never;

    it('returns the base when it is free', async () => {
      await expect(allocateRiderUsername(em([]), 'fm.imran')).resolves.toBe('fm.imran');
    });

    it('walks past the names already taken', async () => {
      await expect(
        allocateRiderUsername(em(['fm.imran', 'fm.imran2', 'fm.imran3']), 'fm.imran'),
      ).resolves.toBe('fm.imran4');
    });

    it('keeps every candidate legal', async () => {
      const u = await allocateRiderUsername(em(['fm.ali']), 'fm.ali');
      ok(u);
    });
  });

  describe('ensureRiderUsername', () => {
    it('leaves an existing username alone', async () => {
      const query = jest.fn();
      const u = await ensureRiderUsername(
        { query } as never,
        { id: 'u1', username: 'fm.existing' },
        'FM2024',
      );
      expect(u).toBe('fm.existing');
      // Nothing read, nothing written — this is the hot path on every attach.
      expect(query).not.toHaveBeenCalled();
    });

    it('names a user who has none, and writes it', async () => {
      const query = jest.fn(async (sql: string) =>
        sql.startsWith('SELECT') ? [] : [],
      );
      const u = await ensureRiderUsername(
        { query } as never,
        { id: 'u1', username: null, displayName: 'Imran Khan' },
        'FM2024',
      );
      expect(u).toBe('fm2024.imran');
      ok(u);
      expect(query).toHaveBeenCalledWith(
        'UPDATE users SET username = $1 WHERE id = $2',
        ['fm2024.imran', 'u1'],
      );
    });
  });
});
