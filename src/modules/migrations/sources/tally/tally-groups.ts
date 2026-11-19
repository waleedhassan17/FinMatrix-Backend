/**
 * TallyPrime's predefined groups → FinMatrix account types.
 *
 * Every Tally ledger sits under a group, and every user-created group sits,
 * eventually, under one of the 28 predefined ones. That chain decides the
 * account type (and a FinMatrix kind), and whether the ledger is a PARTY:
 * a ledger under Sundry Debtors is a customer, under Sundry Creditors a
 * vendor — in FinMatrix those are parties whose balances live on the
 * receivables / payables control accounts, not accounts of their own.
 */
export interface TallyGroupMeaning {
  type: 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
  kind: string;
  /** customer / vendor ledgers, or the stock ledger, route to a control account. */
  role?: 'customer' | 'vendor' | 'stock' | 'cash';
}

export const TALLY_PRIMARY_GROUPS: Record<string, TallyGroupMeaning> = {
  'capital account': { type: 'equity', kind: 'Owner Equity' },
  'reserves & surplus': { type: 'equity', kind: 'Retained Earnings' },
  'current assets': { type: 'asset', kind: 'Other Asset' },
  'bank accounts': { type: 'asset', kind: 'Bank' },
  'cash-in-hand': { type: 'asset', kind: 'Cash', role: 'cash' },
  'deposits (asset)': { type: 'asset', kind: 'Other Asset' },
  'loans & advances (asset)': { type: 'asset', kind: 'Other Asset' },
  'stock-in-hand': { type: 'asset', kind: 'Inventory', role: 'stock' },
  'sundry debtors': {
    type: 'asset',
    kind: 'Accounts Receivable',
    role: 'customer',
  },
  'current liabilities': { type: 'liability', kind: 'Other Liability' },
  'duties & taxes': { type: 'liability', kind: 'Tax Payable' },
  provisions: { type: 'liability', kind: 'Other Liability' },
  'sundry creditors': {
    type: 'liability',
    kind: 'Accounts Payable',
    role: 'vendor',
  },
  'fixed assets': { type: 'asset', kind: 'Fixed Asset' },
  investments: { type: 'asset', kind: 'Other Asset' },
  'loans (liability)': { type: 'liability', kind: 'Notes Payable' },
  'bank od a/c': { type: 'liability', kind: 'Notes Payable' },
  'secured loans': { type: 'liability', kind: 'Notes Payable' },
  'unsecured loans': { type: 'liability', kind: 'Notes Payable' },
  'misc. expenses (asset)': { type: 'asset', kind: 'Other Asset' },
  'suspense a/c': { type: 'liability', kind: 'Other Liability' },
  'branch / divisions': { type: 'liability', kind: 'Other Liability' },
  'direct expenses': { type: 'expense', kind: 'Cost of Goods' },
  'direct incomes': { type: 'revenue', kind: 'Sales' },
  'indirect expenses': { type: 'expense', kind: 'Operating' },
  'indirect incomes': { type: 'revenue', kind: 'Other Revenue' },
  'purchase accounts': { type: 'expense', kind: 'Cost of Goods' },
  'sales accounts': { type: 'revenue', kind: 'Sales' },
};

/** Groups nested inside a predefined group keep their parent's meaning; the most specific wins. */
export function meaningOf(
  group: string | null | undefined,
  parents: Map<string, string>,
): TallyGroupMeaning | null {
  let g = (group ?? '').trim().toLowerCase();
  const seen = new Set<string>();
  while (g && !seen.has(g)) {
    if (TALLY_PRIMARY_GROUPS[g]) return TALLY_PRIMARY_GROUPS[g];
    seen.add(g);
    g = (parents.get(g) ?? '').trim().toLowerCase();
  }
  return null;
}

/** FinMatrix numbers for Tally's reserved ledgers and the control accounts parties route to. */
export const RESERVED_NUMBERS = {
  cash: '1000',
  receivables: '1100',
  inventory: '1200',
  payables: '2000',
  profitAndLoss: '3100',
} as const;

/** Five-digit ranges for new accounts, clear of four-digit charts. */
export const NEW_ACCOUNT_BASE: Record<TallyGroupMeaning['type'], number> = {
  asset: 18001,
  liability: 28001,
  equity: 38001,
  revenue: 48001,
  expense: 68001,
};
