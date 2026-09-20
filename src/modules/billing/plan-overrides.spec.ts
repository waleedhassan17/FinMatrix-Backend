/**
 * The overlay that lets the console edit plan prices.
 *
 * This is the one place in the platform where an admin action changes what a
 * customer is charged, so the invariants get tests: an unedited plan must
 * resolve exactly as configured, an edit must reach the same getPlanConfig()
 * that billing calls, and a retired plan must stay resolvable for whoever is
 * already on it.
 */
import {
  PLAN_CONFIG,
  getPlanConfig,
  getPlanOverride,
  isPlanOffered,
  loadPlanOverrides,
  plansForType,
  type PlanKey,
} from './plan-config';

const KEY: PlanKey = 'warehouse_starter_6mo';

afterEach(() => loadPlanOverrides([]));

describe('with no overrides loaded', () => {
  it('resolves a plan exactly as configured', () => {
    const p = getPlanConfig(KEY);
    expect(p.monthlyMinorUnits).toBe(PLAN_CONFIG[KEY].monthlyMinorUnits);
    expect(p.priceMinorUnits).toBe(PLAN_CONFIG[KEY].priceMinorUnits);
    expect(p.deliveryPersonnelLimit).toBe(PLAN_CONFIG[KEY].deliveryPersonnelLimit);
    expect(p.label).toBe(PLAN_CONFIG[KEY].label);
  });

  it('reports every plan as offered', () => {
    expect(isPlanOffered(KEY)).toBe(true);
  });

  it('reports no override', () => {
    expect(getPlanOverride(KEY)).toBeUndefined();
  });
});

describe('an edited price', () => {
  it('is what getPlanConfig returns — the same call billing makes', () => {
    loadPlanOverrides([[KEY, { monthlyMinorUnits: 999900, priceMinorUnits: 5999400 }]]);

    const p = getPlanConfig(KEY);
    expect(p.monthlyMinorUnits).toBe(999900);
    expect(p.priceMinorUnits).toBe(5999400);
  });

  it('leaves every other plan alone', () => {
    loadPlanOverrides([[KEY, { monthlyMinorUnits: 1 }]]);

    const other: PlanKey = 'warehouse_growth_6mo';
    expect(getPlanConfig(other).monthlyMinorUnits).toBe(
      PLAN_CONFIG[other].monthlyMinorUnits,
    );
  });

  it('leaves unedited fields on the same plan at their configured values', () => {
    loadPlanOverrides([[KEY, { monthlyMinorUnits: 1 }]]);

    const p = getPlanConfig(KEY);
    expect(p.deliveryPersonnelLimit).toBe(PLAN_CONFIG[KEY].deliveryPersonnelLimit);
    expect(p.durationMonths).toBe(PLAN_CONFIG[KEY].durationMonths);
    expect(p.currency).toBe(PLAN_CONFIG[KEY].currency);
  });

  it('never changes the fields that are not editable', () => {
    // key, companyType, durationMonths and currency are deliberately not in
    // PlanOverridePatch; a cast proves the merge ignores them even if one
    // reached the map somehow.
    loadPlanOverrides([
      [KEY, { companyType: 'small_business', durationMonths: 99, currency: 'USD' } as never],
    ]);

    const p = getPlanConfig(KEY);
    expect(p.key).toBe(KEY);
    expect(p.companyType).toBe(PLAN_CONFIG[KEY].companyType);
    expect(p.durationMonths).toBe(PLAN_CONFIG[KEY].durationMonths);
    expect(p.currency).toBe(PLAN_CONFIG[KEY].currency);
  });
});

describe('an edited rider limit', () => {
  it('is what delivery-personnel enforcement reads', () => {
    loadPlanOverrides([[KEY, { deliveryPersonnelLimit: 42 }]]);
    expect(getPlanConfig(KEY).deliveryPersonnelLimit).toBe(42);
  });

  it('can be set to zero, which is a real value and not "unset"', () => {
    loadPlanOverrides([[KEY, { deliveryPersonnelLimit: 0 }]]);
    expect(getPlanConfig(KEY).deliveryPersonnelLimit).toBe(0);
  });
});

describe('retiring a plan', () => {
  it('removes it from what a company type may buy', () => {
    const before = plansForType('warehouse').map((p) => p.key);
    expect(before).toContain(KEY);

    loadPlanOverrides([[KEY, { isOffered: false }]]);

    expect(plansForType('warehouse').map((p) => p.key)).not.toContain(KEY);
  });

  it('keeps it resolvable, so companies already on it still price correctly', () => {
    loadPlanOverrides([[KEY, { isOffered: false }]]);

    // The renewal cron, the rider limit and the expiry job all go through
    // here for a company whose stored plan is this key.
    const p = getPlanConfig(KEY);
    expect(p.key).toBe(KEY);
    expect(p.priceMinorUnits).toBe(PLAN_CONFIG[KEY].priceMinorUnits);
  });

  it('is not the same as editing it — an offered plan stays listed', () => {
    loadPlanOverrides([[KEY, { monthlyMinorUnits: 1 }]]);
    expect(plansForType('warehouse').map((p) => p.key)).toContain(KEY);
  });
});

describe('loadPlanOverrides', () => {
  it('replaces the whole set rather than merging into it', () => {
    loadPlanOverrides([[KEY, { monthlyMinorUnits: 1 }]]);
    loadPlanOverrides([]);

    expect(getPlanConfig(KEY).monthlyMinorUnits).toBe(
      PLAN_CONFIG[KEY].monthlyMinorUnits,
    );
  });
});
