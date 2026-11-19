import {
  DEFAULT_CHART_OF_ACCOUNTS,
  isValidSubType,
  ROLE_AT_DEFAULT_NUMBER,
  SYS,
  SYSTEM_ACCOUNT_DEFS,
  SYSTEM_ROLES,
} from './accounts.constants';

describe('system account definitions', () => {
  const chart = new Map(
    DEFAULT_CHART_OF_ACCOUNTS.map((a) => [a.accountNumber, a]),
  );

  it('mirror the default chart exactly wherever both define an account', () => {
    // A new company is seeded from the chart; an older one gets the account
    // lazily from SYSTEM_ACCOUNT_DEFS. The two must agree or the same role
    // classifies differently across tenants.
    for (const role of SYSTEM_ROLES) {
      const def = SYSTEM_ACCOUNT_DEFS[role];
      const seeded = chart.get(def.defaultNumber);
      if (!seeded) continue;
      expect({
        role,
        name: def.name,
        type: def.type,
        subType: def.subType,
      }).toEqual({
        role,
        name: seeded.name,
        type: seeded.type,
        subType: seeded.subType,
      });
      expect(seeded.systemRole).toBe(role);
    }
  });

  it('give every role its own default number, and only system accounts a role', () => {
    const numbers = SYSTEM_ROLES.map(
      (r) => SYSTEM_ACCOUNT_DEFS[r].defaultNumber,
    );
    expect(new Set(numbers).size).toBe(numbers.length);
    for (const a of DEFAULT_CHART_OF_ACCOUNTS)
      expect(a.systemRole ?? null).toBe(
        ROLE_AT_DEFAULT_NUMBER.get(a.accountNumber) ?? null,
      );
  });

  it('use valid subtypes', () => {
    for (const def of Object.values(SYSTEM_ACCOUNT_DEFS)) {
      expect(isValidSubType(def.type, def.subType)).toBe(true);
    }
  });

  it('keep payroll withholding off Sales Tax Payable', () => {
    expect(SYS.PAYROLL_LIABILITIES).not.toBe(SYS.TAX_PAYABLE);
    expect(SYSTEM_ACCOUNT_DEFS[SYS.PAYROLL_LIABILITIES]).toMatchObject({
      name: 'Payroll Liabilities',
      type: 'liability',
      subType: 'Other Liability',
    });
    expect(
      chart.get(SYSTEM_ACCOUNT_DEFS[SYS.PAYROLL_LIABILITIES].defaultNumber)
        ?.type,
    ).toBe('liability');
  });
});
