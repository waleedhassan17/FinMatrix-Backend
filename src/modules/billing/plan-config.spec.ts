import {
  formatMinorUnits,
  getPlanConfig,
  getPlatformBank,
  normalizePlan,
  PLAN_CONFIG,
  plansForType,
} from './plan-config';

describe('PLAN_CONFIG (phase2.md contract)', () => {
  it('Free: Rs 0, no expiry, 1 delivery person', () => {
    expect(PLAN_CONFIG.free.priceMinorUnits).toBe(0);
    expect(PLAN_CONFIG.free.durationMonths).toBeNull();
    expect(PLAN_CONFIG.free.deliveryPersonnelLimit).toBe(1);
  });

  it('Standard: Rs 1,000/month x 6 months = Rs 6,000, 3 delivery personnel', () => {
    expect(PLAN_CONFIG.standard.monthlyMinorUnits).toBe(100000);
    expect(PLAN_CONFIG.standard.durationMonths).toBe(6);
    expect(PLAN_CONFIG.standard.priceMinorUnits).toBe(600000);
    expect(PLAN_CONFIG.standard.priceMinorUnits).toBe(
      PLAN_CONFIG.standard.monthlyMinorUnits * PLAN_CONFIG.standard.durationMonths!,
    );
    expect(PLAN_CONFIG.standard.deliveryPersonnelLimit).toBe(3);
  });

  it('Pro: Rs 2,000/month x 2 months = Rs 4,000, 3 delivery personnel', () => {
    expect(PLAN_CONFIG.pro.monthlyMinorUnits).toBe(200000);
    expect(PLAN_CONFIG.pro.durationMonths).toBe(2);
    expect(PLAN_CONFIG.pro.priceMinorUnits).toBe(400000);
    expect(PLAN_CONFIG.pro.priceMinorUnits).toBe(
      PLAN_CONFIG.pro.monthlyMinorUnits * PLAN_CONFIG.pro.durationMonths!,
    );
    expect(PLAN_CONFIG.pro.deliveryPersonnelLimit).toBe(3);
  });

  it('normalizePlan falls back to free for unknown/empty values', () => {
    expect(normalizePlan('pro')).toBe('pro');
    expect(normalizePlan('bogus')).toBe('free');
    expect(normalizePlan(null)).toBe('free');
    expect(getPlanConfig(undefined).key).toBe('free');
  });

  it('formatMinorUnits renders rupees', () => {
    expect(formatMinorUnits(100000)).toBe('Rs 1,000');
    expect(formatMinorUnits(200000)).toBe('Rs 2,000');
    expect(formatMinorUnits(0)).toBe('Rs 0');
  });

  it('platform bank account defaults to the configured account', () => {
    const bank = getPlatformBank({} as NodeJS.ProcessEnv);
    expect(bank.accountTitle).toContain('Waleed');
    expect(bank.bankName).toBe('Allied Bank');
    expect(bank.accountNumber).toBeTruthy();
  });
});

describe('Six tier plans (FinMatrix.md CONFIRMED FINAL PRICING, PKR)', () => {
  const expected: Array<[string, string, number, number, number]> = [
    // key, companyType, durationMonths, monthly Rs, total Rs
    ['small_business_3mo', 'small_business', 3, 2500, 7500],
    ['small_business_6mo', 'small_business', 6, 2000, 12000],
    ['large_org_3mo', 'large_org', 3, 5000, 15000],
    ['large_org_6mo', 'large_org', 6, 4000, 24000],
    ['warehouse_3mo', 'warehouse', 3, 4000, 12000],
    ['warehouse_6mo', 'warehouse', 6, 3000, 18000],
  ];

  it.each(expected)('%s: %s, %imo, Rs %i/mo, Rs %i total', (key, type, months, monthly, total) => {
    const p = PLAN_CONFIG[key as keyof typeof PLAN_CONFIG];
    expect(p.companyType).toBe(type);
    expect(p.durationMonths).toBe(months);
    expect(p.monthlyMinorUnits).toBe(monthly * 100);
    expect(p.priceMinorUnits).toBe(total * 100);
    expect(p.priceMinorUnits).toBe(p.monthlyMinorUnits * p.durationMonths!);
    expect(p.currency).toBe('PKR');
  });

  it('every type: the 6-month plan has a LOWER effective monthly rate', () => {
    for (const type of ['small_business', 'large_org', 'warehouse']) {
      const plans = plansForType(type);
      expect(plans).toHaveLength(2);
      const three = plans.find((p) => p.durationMonths === 3)!;
      const six = plans.find((p) => p.durationMonths === 6)!;
      expect(six.monthlyMinorUnits).toBeLessThan(three.monthlyMinorUnits);
    }
  });

  it('NO free plan among the tier plans; legacy keys are never offered', () => {
    for (const type of ['small_business', 'large_org', 'warehouse']) {
      for (const p of plansForType(type)) {
        expect(p.priceMinorUnits).toBeGreaterThan(0);
        expect(['free', 'standard', 'pro']).not.toContain(p.key);
      }
    }
    expect(plansForType(null)).toHaveLength(0); // legacy plans not selectable
  });
});
