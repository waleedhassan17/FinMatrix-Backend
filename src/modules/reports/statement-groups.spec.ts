import {
  accountGroupFor,
  classifyForStatement,
  isCogsAccount,
  isNonOperatingAccount,
  pnlGroupFor,
} from './statement-groups';
import { ACCOUNT_SUB_TYPES } from '../accounts/accounts.constants';

describe('classifyForStatement', () => {
  it.each([
    ['Cash', '1000', 'cashAndBank'],
    ['Bank', '1010', 'cashAndBank'],
    ['Accounts Receivable', '1100', 'receivables'],
    ['Inventory', '1200', 'inventory'],
    ['Inventory', '1250', 'inventory'], // Goods in Transit groups with stock
    ['Prepaid', '1400', 'otherCurrentAssets'],
    ['Fixed Asset', '1500', 'fixedAssets'],
    ['Fixed Asset', '1050', 'fixedAssets'], // subtype beats the number
    ['Other Asset', '1300', 'otherCurrentAssets'], // input tax stays current
    ['Other Asset', '1499', 'otherCurrentAssets'],
    ['Other Asset', '1500', 'fixedAssets'], // the documented 1500 rule
    ['Other Asset', '1800', 'fixedAssets'],
  ])('asset %s #%s → %s', (subType, num, group) => {
    expect(classifyForStatement('asset', subType, num)).toBe(group);
  });

  it.each([
    ['Accounts Payable', '2000', 'currentLiabilities'],
    ['Credit Card', '2100', 'currentLiabilities'],
    ['Payroll Liability', '2310', 'currentLiabilities'],
    ['Tax Payable', '2300', 'currentLiabilities'],
    ['Other Liability', '2050', 'currentLiabilities'],
    ['Other Liability', '2900', 'currentLiabilities'], // subtype beats the number
    ['Notes Payable', '2700', 'longTermLiabilities'],
    ['Notes Payable', '2100', 'longTermLiabilities'],
  ])('liability %s #%s → %s', (subType, num, group) => {
    expect(classifyForStatement('liability', subType, num)).toBe(group);
  });

  it('puts every equity subtype in equity', () => {
    for (const st of ACCOUNT_SUB_TYPES.equity) {
      expect(classifyForStatement('equity', st, '3000')).toBe('equity');
    }
  });

  it('classifies every asset and liability subtype the product offers', () => {
    for (const st of ACCOUNT_SUB_TYPES.asset) {
      expect(classifyForStatement('asset', st, '1000')).not.toBeNull();
    }
    for (const st of ACCOUNT_SUB_TYPES.liability) {
      expect(classifyForStatement('liability', st, '2000')).not.toBeNull();
    }
  });

  it.each([
    ['asset', '1005', 'cashAndBank'],
    ['asset', '1150', 'receivables'],
    ['asset', '1210', 'inventory'],
    ['asset', '1350', 'otherCurrentAssets'],
    ['asset', '1700', 'fixedAssets'],
    ['asset', 'ABC', 'otherCurrentAssets'],
    ['liability', '2200', 'currentLiabilities'],
    ['liability', '2750', 'longTermLiabilities'],
  ])(
    'falls back to the number range only for an unknown subtype: %s #%s → %s',
    (type, num, group) => {
      expect(classifyForStatement(type, '', num)).toBe(group);
      expect(classifyForStatement(type, 'Something Custom', num)).toBe(group);
      expect(classifyForStatement(type, null, num)).toBe(group);
    },
  );

  it('returns null for revenue and expense accounts', () => {
    expect(classifyForStatement('revenue', 'Sales', '4000')).toBeNull();
    expect(classifyForStatement('expense', 'Operating', '6000')).toBeNull();
  });
});

describe('P&L classification', () => {
  it('keeps the COGS rule: subtype or a 5xxx number', () => {
    expect(
      isCogsAccount({ accountNumber: '5000', subType: 'Cost of Goods' }),
    ).toBe(true);
    expect(isCogsAccount({ accountNumber: '5400', subType: 'Operating' })).toBe(
      true,
    );
    expect(
      isCogsAccount({ accountNumber: '6000', subType: 'Cost of Goods' }),
    ).toBe(true);
    expect(isCogsAccount({ accountNumber: '6000', subType: 'Operating' })).toBe(
      false,
    );
  });

  it('treats the real non-operating subtypes as non-operating, by account type', () => {
    expect(
      isNonOperatingAccount({
        accountNumber: '4100',
        subType: 'Interest',
        type: 'revenue',
      }),
    ).toBe(true);
    expect(
      isNonOperatingAccount({
        accountNumber: '4200',
        subType: 'Other Revenue',
        type: 'revenue',
      }),
    ).toBe(true);
    expect(
      isNonOperatingAccount({
        accountNumber: '6900',
        subType: 'Other Expense',
        type: 'expense',
      }),
    ).toBe(true);
    expect(
      isNonOperatingAccount({
        accountNumber: '4000',
        subType: 'Sales',
        type: 'revenue',
      }),
    ).toBe(false);
    expect(
      isNonOperatingAccount({
        accountNumber: '6000',
        subType: 'Operating',
        type: 'expense',
      }),
    ).toBe(false);
  });

  it('keeps the 7xxx/8xxx number rule', () => {
    expect(
      isNonOperatingAccount({
        accountNumber: '7000',
        subType: 'Sales',
        type: 'revenue',
      }),
    ).toBe(true);
    expect(
      isNonOperatingAccount({
        accountNumber: '8000',
        subType: 'Operating',
        type: 'expense',
      }),
    ).toBe(true);
  });

  it('groups P&L rows the way profitLoss splits them', () => {
    expect(
      pnlGroupFor({ accountNumber: '4000', subType: 'Sales', type: 'revenue' }),
    ).toBe('income');
    expect(
      pnlGroupFor({
        accountNumber: '4100',
        subType: 'Interest',
        type: 'revenue',
      }),
    ).toBe('otherIncome');
    expect(
      pnlGroupFor({
        accountNumber: '5000',
        subType: 'Cost of Goods',
        type: 'expense',
      }),
    ).toBe('costOfGoods');
    expect(
      pnlGroupFor({
        accountNumber: '6000',
        subType: 'Operating',
        type: 'expense',
      }),
    ).toBe('expenses');
    expect(
      pnlGroupFor({
        accountNumber: '8000',
        subType: 'Other Expense',
        type: 'expense',
      }),
    ).toBe('otherExpense');
    expect(
      accountGroupFor({
        accountNumber: '1000',
        subType: 'Cash',
        type: 'asset',
      }),
    ).toBe('cashAndBank');
  });
});
