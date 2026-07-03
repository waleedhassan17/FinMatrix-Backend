import {
  formatMinorUnits,
  getPlanConfig,
  getPlatformBank,
  normalizePlan,
  PLAN_CONFIG,
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
