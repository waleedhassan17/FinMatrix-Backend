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

describe('Offered tier plans (PKR)', () => {
  const expected: Array<[string, string | null, number, number, number, number]> = [
    // key, companyType, durationMonths, monthly Rs, total Rs, personnel limit
    // WAREHOUSE-ONLY: small_business/large_org are retired to companyType
    // null — still resolvable for the companies on them, never offered.
    ['small_business_3mo', null, 3, 2500, 7500, 0],
    ['small_business_6mo', null, 6, 2000, 12000, 0],
    ['large_org_3mo', null, 3, 5000, 15000, 0],
    ['large_org_6mo', null, 6, 4000, 24000, 0],
    // Warehouse ladder — tiers differ only by delivery-personnel allowance.
    ['warehouse_starter_3mo', 'warehouse', 3, 3000, 9000, 2],
    ['warehouse_starter_6mo', 'warehouse', 6, 2250, 13500, 2],
    ['warehouse_growth_3mo', 'warehouse', 3, 4000, 12000, 5],
    ['warehouse_growth_6mo', 'warehouse', 6, 3000, 18000, 5],
    ['warehouse_scale_3mo', 'warehouse', 3, 6000, 18000, 10],
    ['warehouse_scale_6mo', 'warehouse', 6, 4500, 27000, 10],
  ];

  it.each(expected)(
    '%s: %s, %imo, Rs %i/mo, Rs %i total, %i personnel',
    (key, type, months, monthly, total, personnel) => {
      const p = PLAN_CONFIG[key as keyof typeof PLAN_CONFIG];
      expect(p.companyType).toBe(type);
      expect(p.durationMonths).toBe(months);
      expect(p.monthlyMinorUnits).toBe(monthly * 100);
      expect(p.priceMinorUnits).toBe(total * 100);
      expect(p.priceMinorUnits).toBe(p.monthlyMinorUnits * p.durationMonths!);
      expect(p.deliveryPersonnelLimit).toBe(personnel);
      expect(p.currency).toBe('PKR');
    },
  );

  it('warehouse offers exactly the 2 / 5 / 10 personnel ladder', () => {
    const plans = plansForType('warehouse');
    expect(plans).toHaveLength(6);
    expect(
      [...new Set(plans.map((p) => p.deliveryPersonnelLimit))].sort((a, b) => a - b),
    ).toEqual([2, 5, 10]);
    // Each limit is available in both billing periods.
    for (const limit of [2, 5, 10]) {
      const forLimit = plans.filter((p) => p.deliveryPersonnelLimit === limit);
      expect(forLimit.map((p) => p.durationMonths).sort()).toEqual([3, 6]);
    }
  });

  it('a higher personnel allowance never costs less per month', () => {
    for (const months of [3, 6]) {
      const rung = plansForType('warehouse')
        .filter((p) => p.durationMonths === months)
        .sort((a, b) => a.deliveryPersonnelLimit - b.deliveryPersonnelLimit);
      for (let i = 1; i < rung.length; i++) {
        expect(rung[i].monthlyMinorUnits).toBeGreaterThan(rung[i - 1].monthlyMinorUnits);
      }
    }
  });

  it('warehouse is the ONLY type with plans on offer', () => {
    expect(plansForType('small_business')).toHaveLength(0);
    expect(plansForType('large_org')).toHaveLength(0);
    expect(plansForType('warehouse')).toHaveLength(6);
  });

  it('retired tier plans still RESOLVE for the companies sitting on them', () => {
    for (const key of ['small_business_6mo', 'large_org_6mo'] as const) {
      const p = getPlanConfig(key);
      expect(p.key).toBe(key); // not silently downgraded to `free`
      expect(p.companyType).toBeNull(); // ⇒ excluded from plansForType
      expect(p.priceMinorUnits).toBeGreaterThan(0);
    }
  });

  it('the 6-month plan has a LOWER effective monthly rate', () => {
    // Warehouse: compare within each personnel rung.
    for (const limit of [2, 5, 10]) {
      const rung = plansForType('warehouse').filter(
        (p) => p.deliveryPersonnelLimit === limit,
      );
      const three = rung.find((p) => p.durationMonths === 3)!;
      const six = rung.find((p) => p.durationMonths === 6)!;
      expect(six.monthlyMinorUnits).toBeLessThan(three.monthlyMinorUnits);
    }
  });

  it('NO free plan among the tier plans; legacy and retired keys are never offered', () => {
    for (const type of ['small_business', 'large_org', 'warehouse']) {
      for (const p of plansForType(type)) {
        expect(p.priceMinorUnits).toBeGreaterThan(0);
        expect(['free', 'standard', 'pro', 'warehouse_3mo', 'warehouse_6mo']).not.toContain(
          p.key,
        );
      }
    }
    expect(plansForType(null)).toHaveLength(0); // legacy/retired not selectable
  });

  it('retired warehouse plans still RESOLVE so existing subscribers keep working', () => {
    for (const key of ['warehouse_3mo', 'warehouse_6mo'] as const) {
      const p = getPlanConfig(key);
      expect(p.key).toBe(key); // not silently downgraded to `free`
      expect(p.companyType).toBeNull(); // ⇒ excluded from plansForType
      expect(p.deliveryPersonnelLimit).toBeGreaterThan(0);
    }
  });
});
