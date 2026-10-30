/**
 * Which section of a statement an account belongs to — decided on the server,
 * once, for every client.
 *
 * The app and the website used to group balance-sheet lines by account-number
 * range, which is a guess about a chart the user can edit. The account's
 * `sub_type` is the user's own statement of what the account is, so it wins;
 * the number range is consulted only when the subtype is empty or not one this
 * product knows (ACCOUNT_SUB_TYPES).
 *
 * Two rules worth stating out loud:
 *
 *  - 'Other Asset' is split by number at 1500. The seeded chart keeps current
 *    items below it (1300 Sales Tax Recoverable is money due back within the
 *    year), and the 1500–1999 block is where non-current assets conventionally
 *    sit in this numbering scheme. An 'Other Asset' numbered 1500 or above is
 *    therefore treated as a fixed (non-current) asset; one below it as current.
 *
 *  - Notes Payable is the only long-term liability subtype. Every other
 *    liability subtype is presumed due within the year.
 */

export type StatementGroupKey =
  | 'cashAndBank'
  | 'receivables'
  | 'inventory'
  | 'otherCurrentAssets'
  | 'fixedAssets'
  | 'currentLiabilities'
  | 'longTermLiabilities'
  | 'equity';

/** Profit & loss groups, for the trial balance's per-row `group`. */
export type PnlGroupKey =
  | 'income'
  | 'costOfGoods'
  | 'expenses'
  | 'otherIncome'
  | 'otherExpense';

export type AccountGroupKey = StatementGroupKey | PnlGroupKey;

/** The balance sheet's sections, in presentation order. */
export const STATEMENT_GROUPS: ReadonlyArray<{
  key: StatementGroupKey;
  label: string;
  side: 'asset' | 'liability' | 'equity';
  current: boolean;
}> = [
  { key: 'cashAndBank', label: 'Cash and Bank', side: 'asset', current: true },
  {
    key: 'receivables',
    label: 'Accounts Receivable',
    side: 'asset',
    current: true,
  },
  { key: 'inventory', label: 'Inventory', side: 'asset', current: true },
  {
    key: 'otherCurrentAssets',
    label: 'Other Current Assets',
    side: 'asset',
    current: true,
  },
  { key: 'fixedAssets', label: 'Fixed Assets', side: 'asset', current: false },
  {
    key: 'currentLiabilities',
    label: 'Current Liabilities',
    side: 'liability',
    current: true,
  },
  {
    key: 'longTermLiabilities',
    label: 'Long-term Liabilities',
    side: 'liability',
    current: false,
  },
  { key: 'equity', label: 'Equity', side: 'equity', current: false },
];

/** P&L groups, in statement order, for the trial balance. */
export const PNL_GROUPS: ReadonlyArray<{ key: PnlGroupKey; label: string }> = [
  { key: 'income', label: 'Income' },
  { key: 'costOfGoods', label: 'Cost of Goods Sold' },
  { key: 'expenses', label: 'Expenses' },
  { key: 'otherIncome', label: 'Other Income' },
  { key: 'otherExpense', label: 'Other Expense' },
];

const ASSET_BY_SUBTYPE: Record<string, StatementGroupKey> = {
  Cash: 'cashAndBank',
  Bank: 'cashAndBank',
  'Accounts Receivable': 'receivables',
  Inventory: 'inventory',
  Prepaid: 'otherCurrentAssets',
  'Fixed Asset': 'fixedAssets',
};

const LIABILITY_BY_SUBTYPE: Record<string, StatementGroupKey> = {
  'Accounts Payable': 'currentLiabilities',
  'Credit Card': 'currentLiabilities',
  'Payroll Liability': 'currentLiabilities',
  'Tax Payable': 'currentLiabilities',
  'Other Liability': 'currentLiabilities',
  'Notes Payable': 'longTermLiabilities',
};

/** The leading integer of an account number, or null when it has none. */
const numberOf = (accountNumber: string | null | undefined): number | null => {
  const m = /^\s*(\d+)/.exec(accountNumber ?? '');
  return m ? parseInt(m[1], 10) : null;
};

/**
 * The balance-sheet section an account belongs to, or null for revenue and
 * expense accounts (which reach the balance sheet only through earnings).
 */
export function classifyForStatement(
  type: string,
  subType: string | null | undefined,
  accountNumber: string | null | undefined,
): StatementGroupKey | null {
  const st = (subType ?? '').trim();
  const n = numberOf(accountNumber);

  if (type === 'asset') {
    if (ASSET_BY_SUBTYPE[st]) return ASSET_BY_SUBTYPE[st];
    if (st === 'Other Asset') {
      return n !== null && n >= 1500 ? 'fixedAssets' : 'otherCurrentAssets';
    }
    // Empty or unknown subtype: fall back to the number range.
    if (n === null) return 'otherCurrentAssets';
    if (n >= 1000 && n <= 1099) return 'cashAndBank';
    if (n >= 1100 && n <= 1199) return 'receivables';
    if (n >= 1200 && n <= 1299) return 'inventory';
    if (n >= 1500) return 'fixedAssets';
    return 'otherCurrentAssets';
  }

  if (type === 'liability') {
    if (LIABILITY_BY_SUBTYPE[st]) return LIABILITY_BY_SUBTYPE[st];
    return n !== null && n >= 2700
      ? 'longTermLiabilities'
      : 'currentLiabilities';
  }

  if (type === 'equity') return 'equity';
  return null;
}

/**
 * Cost of goods sold: the explicit subtype, or a 5xxx account number. The
 * rule profitLoss has always applied, kept here so every report shares it.
 */
export function isCogsAccount(row: {
  accountNumber: string;
  subType: string | null;
}): boolean {
  return (
    row.subType === 'Cost of Goods' || (row.accountNumber ?? '').startsWith('5')
  );
}

/**
 * NON-operating income or expense — interest, FX, disposals, one-offs. Kept
 * out of the operating subtotal so `netOperatingIncome` reflects the trade the
 * business actually runs.
 *
 * The subtype is checked against the subtypes the product actually offers
 * (ACCOUNT_SUB_TYPES): revenue 'Other Revenue' and 'Interest', expense
 * 'Other Expense'. It used to look for 'Other Income', which is not a subtype
 * anyone can choose, so an interest account numbered 4xxx was reported as
 * operating income. 'Other Income' still matches, harmlessly, for any legacy
 * row that carries it. The 7xxx/8xxx number rule is unchanged.
 */
export function isNonOperatingAccount(row: {
  accountNumber: string;
  subType: string | null;
  type?: string;
}): boolean {
  const n = row.accountNumber ?? '';
  if (n.startsWith('7') || n.startsWith('8')) return true;
  const st = row.subType ?? '';
  if (st === 'Other Income') return true;
  if (row.type === undefined) {
    return (
      st === 'Other Revenue' || st === 'Interest' || st === 'Other Expense'
    );
  }
  if (row.type === 'revenue')
    return st === 'Other Revenue' || st === 'Interest';
  if (row.type === 'expense') return st === 'Other Expense';
  return false;
}

/** The P&L group of a revenue or expense account, exactly as profitLoss splits it. */
export function pnlGroupFor(row: {
  accountNumber: string;
  subType: string | null;
  type: string;
}): PnlGroupKey | null {
  if (row.type === 'revenue')
    return isNonOperatingAccount(row) ? 'otherIncome' : 'income';
  if (row.type === 'expense') {
    if (isCogsAccount(row)) return 'costOfGoods';
    return isNonOperatingAccount(row) ? 'otherExpense' : 'expenses';
  }
  return null;
}

/** Any account's group: balance-sheet section or P&L group. */
export function accountGroupFor(row: {
  accountNumber: string;
  subType: string | null;
  type: string;
}): AccountGroupKey | null {
  return (
    classifyForStatement(row.type, row.subType, row.accountNumber) ??
    pnlGroupFor(row)
  );
}

/** Human label for any group key. */
export function groupLabel(key: AccountGroupKey): string {
  return (
    STATEMENT_GROUPS.find((g) => g.key === key)?.label ??
    PNL_GROUPS.find((g) => g.key === key)?.label ??
    key
  );
}
