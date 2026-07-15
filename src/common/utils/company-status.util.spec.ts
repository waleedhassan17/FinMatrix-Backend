import {
  effectiveCompanyStatus,
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
});
