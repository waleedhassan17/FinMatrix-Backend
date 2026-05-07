import { AccountType } from '../../types';

export const ACCOUNT_SUB_TYPES: Record<AccountType, readonly string[]> = {
  asset: [
    'Cash',
    'Bank',
    'Accounts Receivable',
    'Inventory',
    'Prepaid',
    'Fixed Asset',
    'Other Asset',
  ],
  liability: [
    'Accounts Payable',
    'Credit Card',
    'Payroll Liability',
    'Tax Payable',
    'Notes Payable',
    'Other Liability',
  ],
  equity: ['Owner Equity', 'Retained Earnings', 'Owner Draws', 'Other Equity'],
  revenue: ['Sales', 'Service', 'Interest', 'Other Revenue'],
  expense: [
    'Cost of Goods',
    'Operating',
    'Payroll',
    'Tax',
    'Depreciation',
    'Other Expense',
  ],
};

export function isValidSubType(type: AccountType, subType: string): boolean {
  return ACCOUNT_SUB_TYPES[type].includes(subType);
}

/**
 * Default chart of accounts seeded on company creation.
 * Numbering scheme mirrors the product spec.
 */
export interface DefaultAccountSeed {
  accountNumber: string;
  name: string;
  type: AccountType;
  subType: string;
}

export const DEFAULT_CHART_OF_ACCOUNTS: DefaultAccountSeed[] = [
  { accountNumber: '1000', name: 'Cash', type: 'asset', subType: 'Cash' },
  { accountNumber: '1010', name: 'Business Checking', type: 'asset', subType: 'Bank' },
  {
    accountNumber: '1100',
    name: 'Accounts Receivable',
    type: 'asset',
    subType: 'Accounts Receivable',
  },
  { accountNumber: '1200', name: 'Inventory', type: 'asset', subType: 'Inventory' },
  {
    accountNumber: '2000',
    name: 'Accounts Payable',
    type: 'liability',
    subType: 'Accounts Payable',
  },
  {
    accountNumber: '2300',
    name: 'Sales Tax Payable',
    type: 'liability',
    subType: 'Tax Payable',
  },
  { accountNumber: '3000', name: 'Owner Equity', type: 'equity', subType: 'Owner Equity' },
  {
    accountNumber: '3100',
    name: 'Retained Earnings',
    type: 'equity',
    subType: 'Retained Earnings',
  },
  { accountNumber: '4000', name: 'Sales Revenue', type: 'revenue', subType: 'Sales' },
  {
    accountNumber: '5000',
    name: 'Cost of Goods Sold',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  { accountNumber: '6000', name: 'Rent Expense', type: 'expense', subType: 'Operating' },
  {
    accountNumber: '6100',
    name: 'Utilities Expense',
    type: 'expense',
    subType: 'Operating',
  },
  { accountNumber: '6200', name: 'Salary Expense', type: 'expense', subType: 'Payroll' },
  {
    accountNumber: '6300',
    name: 'Office Supplies',
    type: 'expense',
    subType: 'Operating',
  },
];

/**
 * Canonical account numbers referenced by auto-journal entries.
 */
export const ACCT_CASH = '1000';
export const ACCT_BANK = '1010';
export const ACCT_AR = '1100';
export const ACCT_AP = '2000';
export const ACCT_TAX_PAYABLE = '2300';
export const ACCT_SALES_REVENUE = '4000';
export const ACCT_COGS = '5000';
