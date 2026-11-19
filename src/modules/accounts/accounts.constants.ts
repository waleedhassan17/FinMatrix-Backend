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
  /** What automatic posting uses this account for; null for an ordinary account. */
  systemRole?: SystemRole | null;
}

const CHART_SEED: DefaultAccountSeed[] = [
  { accountNumber: '1000', name: 'Cash', type: 'asset', subType: 'Cash' },
  {
    accountNumber: '1010',
    name: 'Business Checking',
    type: 'asset',
    subType: 'Bank',
  },
  {
    accountNumber: '1100',
    name: 'Accounts Receivable',
    type: 'asset',
    subType: 'Accounts Receivable',
  },
  {
    accountNumber: '1200',
    name: 'Inventory',
    type: 'asset',
    subType: 'Inventory',
  },
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
  {
    accountNumber: '2310',
    name: 'Payroll Liabilities',
    type: 'liability',
    subType: 'Other Liability',
  },
  {
    accountNumber: '3000',
    name: 'Owner Equity',
    type: 'equity',
    subType: 'Owner Equity',
  },
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
  // Migration Center (modules/migrations). Every posting a migration makes
  // nets through here: the trial balance's AR, AP and Inventory lines land on
  // it instead of the control accounts, and the open invoices, open bills and
  // stock detail post against it. A finished migration leaves it at exactly
  // zero; anything else means the detail disagrees with the trial balance and
  // the commit refuses. Kept apart from 3900 so an opening balance typed by
  // hand and a migrated one never blur into one number.
  {
    accountNumber: '3950',
    name: 'Migration Clearing',
    type: 'equity',
    subType: 'Other Equity',
  },
  {
    accountNumber: '4000',
    name: 'Sales Revenue',
    type: 'revenue',
    subType: 'Sales',
  },
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
  {
    accountNumber: '6000',
    name: 'Rent Expense',
    type: 'expense',
    subType: 'Operating',
  },
  {
    accountNumber: '6100',
    name: 'Utilities Expense',
    type: 'expense',
    subType: 'Operating',
  },
  {
    accountNumber: '6200',
    name: 'Salary Expense',
    type: 'expense',
    subType: 'Payroll',
  },
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
 * What automatic posting needs an account for. An account keeps its role
 * whatever its number or name becomes: a company that moved from Peachtree
 * keeps Receivables at 11000 under Peachtree's name, and invoices still post
 * there. Everything that posts by itself finds its account by role
 * (AccountsService.getSystemAccount), never by number.
 */
export const SYS = {
  CASH: 'cash',
  BANK: 'bank',
  AR: 'accounts_receivable',
  INVENTORY: 'inventory',
  GOODS_IN_TRANSIT: 'goods_in_transit',
  INPUT_TAX: 'input_tax',
  AP: 'accounts_payable',
  GRNI: 'grni',
  TAX_PAYABLE: 'sales_tax_payable',
  /**
   * Amounts withheld from employees' pay and owed onward (income tax, EOBI,
   * loans). Deliberately not Sales Tax Payable: the tax liability report reads
   * every credit to that account as output sales tax.
   */
  PAYROLL_LIABILITIES: 'payroll_liabilities',
  CUSTOMER_ADVANCES: 'customer_advances',
  OWNER_EQUITY: 'owner_equity',
  RETAINED_EARNINGS: 'retained_earnings',
  OPENING_BALANCE_EQUITY: 'opening_balance_equity',
  /** Migration Center clearing account; nets to zero after a committed batch. */
  MIGRATION_CLEARING: 'migration_clearing',
  SALES_REVENUE: 'sales_revenue',
  COGS: 'cogs',
  SALARY_EXPENSE: 'salary_expense',
  SHRINKAGE_DAMAGE: 'shrinkage_damage',
  SHRINKAGE_THEFT: 'shrinkage_theft',
  SHRINKAGE_OBSOLESCENCE: 'shrinkage_obsolescence',
  INVENTORY_COUNT_VARIANCE: 'inventory_count_variance',
  /**
   * Legacy. Every adjustment posted here before the reason drove the account,
   * and it stays in the chart — as an OPERATING expense — so historical
   * entries keep reporting where they were posted. New adjustments use the
   * shrinkage and count-variance accounts.
   */
  INVENTORY_ADJUSTMENT: 'inventory_adjustment',
} as const;

export type SystemRole = (typeof SYS)[keyof typeof SYS];

export interface SystemAccountDef {
  /** Where a new company's chart puts it; it may move later. */
  defaultNumber: string;
  name: string;
  type: AccountType;
  subType: string;
}

/**
 * Every system account: where it starts, and what it must stay (type and
 * kind never change). New companies get these from DEFAULT_CHART_OF_ACCOUNTS;
 * an older company missing one gets it lazily
 * (AccountsService.getOrCreateSystemAccount). The two must agree.
 */
export const SYSTEM_ACCOUNT_DEFS: Record<SystemRole, SystemAccountDef> = {
  cash: { defaultNumber: '1000', name: 'Cash', type: 'asset', subType: 'Cash' },
  bank: {
    defaultNumber: '1010',
    name: 'Business Checking',
    type: 'asset',
    subType: 'Bank',
  },
  accounts_receivable: {
    defaultNumber: '1100',
    name: 'Accounts Receivable',
    type: 'asset',
    subType: 'Accounts Receivable',
  },
  inventory: {
    defaultNumber: '1200',
    name: 'Inventory',
    type: 'asset',
    subType: 'Inventory',
  },
  goods_in_transit: {
    defaultNumber: '1250',
    name: 'Goods in Transit',
    type: 'asset',
    subType: 'Inventory',
  },
  input_tax: {
    defaultNumber: '1300',
    name: 'Sales Tax Recoverable (Input Tax)',
    type: 'asset',
    subType: 'Other Asset',
  },
  accounts_payable: {
    defaultNumber: '2000',
    name: 'Accounts Payable',
    type: 'liability',
    subType: 'Accounts Payable',
  },
  grni: {
    defaultNumber: '2050',
    name: 'Inventory Received Not Billed (GRNI)',
    type: 'liability',
    subType: 'Other Liability',
  },
  sales_tax_payable: {
    defaultNumber: '2300',
    name: 'Sales Tax Payable',
    type: 'liability',
    subType: 'Tax Payable',
  },
  payroll_liabilities: {
    defaultNumber: '2310',
    name: 'Payroll Liabilities',
    type: 'liability',
    subType: 'Other Liability',
  },
  // Cash taken before the goods are handed over is not income yet: it is a
  // contract liability until control transfers on delivery (IFRS 15 / ASC 606).
  customer_advances: {
    defaultNumber: '2400',
    name: 'Customer Advances (Unearned Revenue)',
    type: 'liability',
    subType: 'Other Liability',
  },
  owner_equity: {
    defaultNumber: '3000',
    name: 'Owner Equity',
    type: 'equity',
    subType: 'Owner Equity',
  },
  retained_earnings: {
    defaultNumber: '3100',
    name: 'Retained Earnings',
    type: 'equity',
    subType: 'Retained Earnings',
  },
  opening_balance_equity: {
    defaultNumber: '3900',
    name: 'Opening Balance Equity',
    type: 'equity',
    subType: 'Opening Balance Equity',
  },
  migration_clearing: {
    defaultNumber: '3950',
    name: 'Migration Clearing',
    type: 'equity',
    subType: 'Other Equity',
  },
  sales_revenue: {
    defaultNumber: '4000',
    name: 'Sales Revenue',
    type: 'revenue',
    subType: 'Sales',
  },
  cogs: {
    defaultNumber: '5000',
    name: 'Cost of Goods Sold',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  shrinkage_damage: {
    defaultNumber: '5400',
    name: 'Inventory Shrinkage – Damage',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  shrinkage_theft: {
    defaultNumber: '5410',
    name: 'Inventory Shrinkage – Theft',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  shrinkage_obsolescence: {
    defaultNumber: '5420',
    name: 'Inventory Shrinkage – Obsolescence',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  inventory_count_variance: {
    defaultNumber: '5430',
    name: 'Inventory Count Variance',
    type: 'expense',
    subType: 'Cost of Goods',
  },
  salary_expense: {
    defaultNumber: '6200',
    name: 'Salary Expense',
    type: 'expense',
    subType: 'Payroll',
  },
  inventory_adjustment: {
    defaultNumber: '6400',
    name: 'Inventory Adjustment / Shrinkage',
    type: 'expense',
    subType: 'Operating',
  },
};

export const SYSTEM_ROLES = Object.keys(SYSTEM_ACCOUNT_DEFS) as SystemRole[];

/** The role a default-chart number starts with (used to seed and to backfill). */
export const ROLE_AT_DEFAULT_NUMBER: ReadonlyMap<string, SystemRole> = new Map(
  SYSTEM_ROLES.map((r) => [SYSTEM_ACCOUNT_DEFS[r].defaultNumber, r]),
);

/** Default chart of accounts seeded on company creation, each system account with its role. */
export const DEFAULT_CHART_OF_ACCOUNTS: DefaultAccountSeed[] = CHART_SEED.map(
  (a) => ({
    ...a,
    systemRole: ROLE_AT_DEFAULT_NUMBER.get(a.accountNumber) ?? null,
  }),
);

/**
 * Postings that bring in a position held BEFORE the books started — not
 * activity of the period they are dated in: a manual opening-balance entry,
 * opening stock, a Migration Center import and the undo of one. Reports that
 * describe a period's activity (cash flow, the sales-tax return, the sales
 * reconciliation) show these apart from that activity.
 */
export const OPENING_POSITION_SOURCE_TYPES: readonly string[] = [
  'opening_balance',
  'opening_stock',
  'migration',
  'migration_rollback',
];

/**
 * Which account an inventory adjustment offsets against, by reason.
 *
 * The reason used to be decorative — it reached the journal memo and nothing
 * else, so damage, theft and obsolescence were indistinguishable in the P&L.
 * This map is the single source of truth; postInventoryAdjustmentJe() reads
 * it, and the chosen account's number is persisted on the adjustment row so a
 * reversal can mirror it exactly (a used account's number no longer changes).
 *
 * 'reversal' never selects from here: reverseAdjustment() reads the ORIGINAL
 * adjustment's offset_account_number. It is mapped only to keep the Record
 * total, and points at the legacy account as an inert fallback.
 */
export const ADJUSTMENT_REASON_ACCOUNTS: Record<
  InventoryAdjustmentReason,
  SystemRole
> = {
  damage: SYS.SHRINKAGE_DAMAGE,
  theft: SYS.SHRINKAGE_THEFT,
  obsolescence: SYS.SHRINKAGE_OBSOLESCENCE,
  // A count variance and a data-entry correction are the same event
  // accounting-wise: the books said one thing, the shelf said another.
  physical_count: SYS.INVENTORY_COUNT_VARIANCE,
  correction: SYS.INVENTORY_COUNT_VARIANCE,
  other: SYS.INVENTORY_COUNT_VARIANCE,
  reversal: SYS.INVENTORY_ADJUSTMENT,
};
