import {
  ACCT_PAYROLL_LIABILITIES,
  ACCT_TAX_PAYABLE,
  DEFAULT_CHART_OF_ACCOUNTS,
  SYSTEM_ACCOUNT_DEFS,
  isValidSubType,
} from './accounts.constants';

describe('system account definitions', () => {
  const chart = new Map(DEFAULT_CHART_OF_ACCOUNTS.map((a) => [a.accountNumber, a]));

  it('mirror the default chart exactly wherever both define an account', () => {
    // A new company is seeded from the chart; an older one gets the account
    // lazily from SYSTEM_ACCOUNT_DEFS. The two must agree or the same number
    // classifies differently across tenants.
    for (const [number, def] of Object.entries(SYSTEM_ACCOUNT_DEFS)) {
      const seeded = chart.get(number);
      if (!seeded) continue;
      expect({ number, name: def.name, type: def.type, subType: def.subType }).toEqual({
        number,
        name: seeded.name,
        type: seeded.type,
        subType: seeded.subType,
      });
    }
  });

  it('use valid subtypes', () => {
    for (const def of Object.values(SYSTEM_ACCOUNT_DEFS)) {
      expect(isValidSubType(def.type, def.subType)).toBe(true);
    }
  });

  it('keep payroll withholding off Sales Tax Payable', () => {
    expect(ACCT_PAYROLL_LIABILITIES).not.toBe(ACCT_TAX_PAYABLE);
    expect(SYSTEM_ACCOUNT_DEFS[ACCT_PAYROLL_LIABILITIES]).toEqual({
      name: 'Payroll Liabilities',
      type: 'liability',
      subType: 'Other Liability',
    });
    expect(chart.get(ACCT_PAYROLL_LIABILITIES)?.type).toBe('liability');
  });
});
