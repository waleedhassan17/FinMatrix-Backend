import { AccountType, InventoryAdjustmentReason } from '../../types';

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
  equity: [
    'Owner Equity',
    'Retained Earnings',
    'Owner Draws',
    'Opening Balance Equity',
    'Other Equity',
  ],
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
    accountNumber: '1250',
    name: 'Goods in Transit',
    type: 'asset',
    subType: 'Inventory',
  },
  {
    accountNumber: '1300',
    name: 'Sales Tax Recoverable (Input Tax)',
    type: 'asset',
    subType: 'Other Asset',
  },
  {
    accountNumber: '2000',
    name: 'Accounts Payable',
    type: 'liability',
    subType: 'Accounts Payable',
  },
  {
    accountNumber: '2050',
    name: 'Inventory Received Not Billed (GRNI)',
    type: 'liability',
    subType: 'Other Liability',
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
  {
    accountNumber: '3900',
    name: 'Opening Balance Equity',
    type: 'equity',
    subType: 'Opening Balance Equity',
  },
  { accountNumber: '4000', name: 'Sales Revenue', type: 'revenue', subType: 'Sales' },
  {
    accountNumber: '5000',
    name: 'Cost of Goods Sold',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  // Inventory shrinkage, split by cause. Deliberately 54xx / 'Cost of Goods':
  // stock that was bought to sell and then lost is a cost of goods, so it
  // belongs above the Gross Profit line — which is where QuickBooks puts it,
  // and what makes our margins comparable to theirs. See
  // ADJUSTMENT_REASON_ACCOUNTS below for which reason lands where.
  {
    accountNumber: '5400',
    name: 'Inventory Shrinkage – Damage',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  {
    accountNumber: '5410',
    name: 'Inventory Shrinkage – Theft',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  {
    accountNumber: '5420',
    name: 'Inventory Shrinkage – Obsolescence',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  {
    accountNumber: '5430',
    name: 'Inventory Count Variance',
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
  {
    accountNumber: '6400',
    name: 'Inventory Adjustment / Shrinkage',
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
export const ACCT_INVENTORY = '1200';
export const ACCT_GOODS_IN_TRANSIT = '1250';
export const ACCT_INPUT_TAX = '1300';
export const ACCT_SALARY_EXPENSE = '6200';
export const ACCT_GRNI = '2050';
export const ACCT_AP = '2000';
export const ACCT_TAX_PAYABLE = '2300';
export const ACCT_CUSTOMER_ADVANCES = '2400';
export const ACCT_OPENING_BALANCE_EQUITY = '3900';
export const ACCT_SALES_REVENUE = '4000';
export const ACCT_COGS = '5000';
export const ACCT_SHRINKAGE_DAMAGE = '5400';
export const ACCT_SHRINKAGE_THEFT = '5410';
export const ACCT_SHRINKAGE_OBSOLESCENCE = '5420';
export const ACCT_INVENTORY_COUNT_VARIANCE = '5430';
/**
 * Legacy. Every adjustment posted here before the reason drove the account,
 * and it stays in the chart — as an OPERATING expense — so historical entries
 * keep reporting where they were posted. New adjustments use the 54xx
 * accounts above. Also the fallback for reversing an adjustment written
 * before offset_account_number existed.
 */
export const ACCT_INVENTORY_ADJUSTMENT = '6400';

/**
 * Which account an inventory adjustment offsets against, by reason.
 *
 * The reason used to be decorative — it reached the journal memo and nothing
 * else, so damage, theft and obsolescence were indistinguishable in the P&L.
 * This map is the single source of truth; postInventoryAdjustmentJe() reads
 * it, and the chosen account is persisted on the adjustment row so a reversal
 * can mirror it exactly.
 *
 * 'reversal' never selects from here: reverseAdjustment() reads the ORIGINAL
 * adjustment's offset_account_number. It is mapped only to keep the Record
 * total, and points at the legacy account as an inert fallback.
 */
export const ADJUSTMENT_REASON_ACCOUNTS: Record<InventoryAdjustmentReason, string> = {
  damage: ACCT_SHRINKAGE_DAMAGE,
  theft: ACCT_SHRINKAGE_THEFT,
  obsolescence: ACCT_SHRINKAGE_OBSOLESCENCE,
  // A count variance and a data-entry correction are the same event
  // accounting-wise: the books said one thing, the shelf said another.
  physical_count: ACCT_INVENTORY_COUNT_VARIANCE,
  correction: ACCT_INVENTORY_COUNT_VARIANCE,
  other: ACCT_INVENTORY_COUNT_VARIANCE,
  reversal: ACCT_INVENTORY_ADJUSTMENT,
};

/**
 * System accounts that auto-posting depends on. Resolved by number and
 * lazily created for companies whose chart predates these additions
 * (see AccountsService.getOrCreateSystemAccount).
 */
export const SYSTEM_ACCOUNT_DEFS: Record<
  string,
  { name: string; type: AccountType; subType: string }
> = {
  [ACCT_OPENING_BALANCE_EQUITY]: {
    name: 'Opening Balance Equity',
    type: 'equity',
    subType: 'Opening Balance Equity',
  },
  [ACCT_GRNI]: {
    name: 'Inventory Received Not Billed (GRNI)',
    type: 'liability',
    subType: 'Other Liability',
  },
  [ACCT_INVENTORY_ADJUSTMENT]: {
    name: 'Inventory Adjustment / Shrinkage',
    type: 'expense',
    subType: 'Operating',
  },
  // Must mirror DEFAULT_CHART_OF_ACCOUNTS exactly: that list seeds new
  // companies, this one lazily creates the account for companies whose chart
  // predates it. Divergence would give two different subTypes for the same
  // number across tenants, and the P&L would classify them differently.
  [ACCT_SHRINKAGE_DAMAGE]: {
    name: 'Inventory Shrinkage – Damage',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  [ACCT_SHRINKAGE_THEFT]: {
    name: 'Inventory Shrinkage – Theft',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  [ACCT_SHRINKAGE_OBSOLESCENCE]: {
    name: 'Inventory Shrinkage – Obsolescence',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  [ACCT_INVENTORY_COUNT_VARIANCE]: {
    name: 'Inventory Count Variance',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  [ACCT_INPUT_TAX]: {
    name: 'Sales Tax Recoverable (Input Tax)',
    type: 'asset',
    subType: 'Other Asset',
  },
  [ACCT_GOODS_IN_TRANSIT]: {
    name: 'Goods in Transit',
    type: 'asset',
    subType: 'Inventory',
  },
  // Cash taken before the goods are handed over is not income yet: it is a
  // contract liability until control transfers on delivery (IFRS 15 / ASC 606).
  [ACCT_CUSTOMER_ADVANCES]: {
    name: 'Customer Advances (Unearned Revenue)',
    type: 'liability',
    subType: 'Other Liability',
  },
};
