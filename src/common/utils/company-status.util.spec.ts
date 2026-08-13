import {
  effectiveCompanyStatus,
  isCompanyDraft,
  isSubscriptionExpired,
  normalizeCompanyStatus,
} from './company-status.util';

describe('company-status.util', () => {
  const NOW = new Date('2026-07-15T12:00:00Z');
  const PAST = new Date('2026-07-14T00:00:00Z');
  const FUTURE = new Date('2026-12-01T00:00:00Z');

  describe('isSubscriptionExpired (live check)', () => {
    it('is false for free plans regardless of dates', () => {
      expect(
        isSubscriptionExpired(
          { subscriptionPlan: 'free', subscriptionExpiryDate: PAST },
          NOW,
        ),
      ).toBe(false);
    });

    it('is false when no expiry date is set', () => {
      expect(
        isSubscriptionExpired(
          { subscriptionPlan: 'warehouse_3mo', subscriptionExpiryDate: null },
          NOW,
        ),
      ).toBe(false);
    });

    it('is false while the expiry date is in the future', () => {
      expect(
        isSubscriptionExpired(
          { subscriptionPlan: 'large_org_6mo', subscriptionExpiryDate: FUTURE },
          NOW,
        ),
      ).toBe(false);
    });

    it('is true once the expiry date has passed', () => {
      expect(
        isSubscriptionExpired(
          { subscriptionPlan: 'large_org_6mo', subscriptionExpiryDate: PAST },
          NOW,
        ),
      ).toBe(true);
    });

    it('accepts ISO strings (raw SQL rows)', () => {
      expect(
        isSubscriptionExpired(
          {
            subscriptionPlan: 'small_business_6mo',
            subscriptionExpiryDate: '2026-07-14T00:00:00.000Z',
          },
          NOW,
        ),
      ).toBe(true);
    });
  });

  describe('effectiveCompanyStatus', () => {
    it('downgrades an active company with a lapsed paid plan to inactive', () => {
      expect(
        effectiveCompanyStatus(
          {
            status: 'approved',
            subscriptionPlan: 'large_org_6mo',
            subscriptionExpiryDate: PAST,
          },
          NOW,
        ),
      ).toBe('inactive');
    });

    it('keeps an active company with a current paid plan active', () => {
      expect(
        effectiveCompanyStatus(
          {
            status: 'approved',
            subscriptionPlan: 'large_org_6mo',
            subscriptionExpiryDate: FUTURE,
          },
          NOW,
        ),
      ).toBe('active');
    });

    it('never resurrects pending/rejected/inactive statuses', () => {
      for (const status of ['pending_approval', 'rejected', 'inactive']) {
        expect(
          effectiveCompanyStatus(
            {
              status,
              subscriptionPlan: 'large_org_6mo',
              subscriptionExpiryDate: FUTURE,
            },
            NOW,
          ),
        ).toBe(normalizeCompanyStatus(status));
      }
    });

    it('handles null company (no membership)', () => {
      // Legacy semantics: normalizeCompanyStatus(undefined) === 'active'.
      expect(effectiveCompanyStatus(null, NOW)).toBe('active');
    });
  });

  describe('draft vs pending (onboarding resume)', () => {
    it('email_verified normalizes to draft, NOT pending', () => {
      // The company row exists but was never submitted. Collapsing it into
      // `pending` is what showed a half-finished registration the
      // "Awaiting approval" screen and blocked its owner from signing in.
      expect(normalizeCompanyStatus('email_verified')).toBe('draft');
    });

    it('a submitted company is still pending', () => {
      expect(normalizeCompanyStatus('pending_approval')).toBe('pending');
      expect(normalizeCompanyStatus('pending')).toBe('pending');
    });

    it('leaves every other mapping untouched', () => {
      expect(normalizeCompanyStatus('approved')).toBe('active');
      expect(normalizeCompanyStatus('active')).toBe('active');
      expect(normalizeCompanyStatus('rejected')).toBe('rejected');
      expect(normalizeCompanyStatus('inactive')).toBe('inactive');
      expect(normalizeCompanyStatus('suspended')).toBe('inactive');
      expect(normalizeCompanyStatus('unverified')).toBe('pending');
      expect(normalizeCompanyStatus('something-new')).toBe('pending');
      // Legacy rows with no status stay active — pinned by the spec below too.
      expect(normalizeCompanyStatus(null)).toBe('active');
      expect(normalizeCompanyStatus(undefined)).toBe('active');
      expect(normalizeCompanyStatus('')).toBe('active');
    });

    it('a draft is never downgraded by the subscription expiry check', () => {
      // The expiry downgrade only applies on top of `active`; a draft has no
      // plan yet, so it must report draft regardless of any expiry date.
      expect(
        effectiveCompanyStatus(
          { status: 'email_verified', subscriptionPlan: 'warehouse_growth_6mo', subscriptionExpiryDate: PAST },
          NOW,
        ),
      ).toBe('draft');
      expect(effectiveCompanyStatus({ status: 'email_verified' }, NOW)).toBe('draft');
    });

    it('isCompanyDraft answers only for the draft state', () => {
      expect(isCompanyDraft('email_verified')).toBe(true);
      expect(isCompanyDraft('pending_approval')).toBe(false);
      expect(isCompanyDraft('approved')).toBe(false);
      expect(isCompanyDraft(null)).toBe(false);
    });
  });
});
