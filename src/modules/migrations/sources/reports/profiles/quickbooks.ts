/**
 * QuickBooks Online and QuickBooks Desktop (Windows and Mac) exports.
 *
 * Online: Reports → (report) → Export → Export to Excel; or Settings → Tools
 * → Export data (a ZIP of Excel reports and lists). Desktop: Reports → … →
 * Excel → Create New Worksheet (or CSV); lists via File → Utilities → Export
 * → Lists to IIF Files.
 *
 * QuickBooks names customers, vendors and items rather than coding them, so
 * FinMatrix gives them codes; accounts without numbers are numbered by type.
 * Aged detail reports are grouped by aging bucket with the customer on each
 * line; the trial balance has no title over its account column.
 */
import { ReportProfile, ReportSpec } from '../report-engine';

const ACCOUNT_TYPES: ReportProfile['accountTypes'] = {
  // Report type names (Online and Desktop spell them slightly differently).
  bank: { type: 'Asset', kind: 'Bank' },
  'accounts receivable a r': { type: 'Asset', kind: 'Accounts Receivable' },
  'accounts receivable': { type: 'Asset', kind: 'Accounts Receivable' },
  'other current assets': { type: 'Asset', kind: 'Other Asset' },
  'other current asset': { type: 'Asset', kind: 'Other Asset' },
  'fixed assets': { type: 'Asset', kind: 'Fixed Asset' },
  'fixed asset': { type: 'Asset', kind: 'Fixed Asset' },
  'other assets': { type: 'Asset', kind: 'Other Asset' },
  'other asset': { type: 'Asset', kind: 'Other Asset' },
  'accounts payable a p': { type: 'Liability', kind: 'Accounts Payable' },
  'accounts payable': { type: 'Liability', kind: 'Accounts Payable' },
  'credit card': { type: 'Liability', kind: 'Credit Card' },
  'other current liabilities': { type: 'Liability', kind: 'Other Liability' },
  'other current liability': { type: 'Liability', kind: 'Other Liability' },
  'long term liabilities': { type: 'Liability', kind: 'Notes Payable' },
  'long term liability': { type: 'Liability', kind: 'Notes Payable' },
  equity: { type: 'Equity', kind: 'Owner Equity' },
  income: { type: 'Revenue', kind: 'Sales' },
  'cost of goods sold': { type: 'Expense', kind: 'Cost of Goods' },
  expenses: { type: 'Expense', kind: 'Operating' },
  expense: { type: 'Expense', kind: 'Operating' },
  'other income': { type: 'Revenue', kind: 'Other Revenue' },
  'other expense': { type: 'Expense', kind: 'Other Expense' },
  // Detail types that change the kind (Online).
  'other current assets|inventory': { type: 'Asset', kind: 'Inventory' },
  'bank|cash on hand': { type: 'Asset', kind: 'Cash' },
  'equity|retained earnings': { type: 'Equity', kind: 'Retained Earnings' },
  'equity|opening balance equity': {
    type: 'Equity',
    kind: 'Opening Balance Equity',
  },
  'equity|owner s equity': { type: 'Equity', kind: 'Owner Equity' },
  // IIF ACCNTTYPE codes (Desktop).
  ar: { type: 'Asset', kind: 'Accounts Receivable' },
  ocasset: { type: 'Asset', kind: 'Other Asset' },
  fixasset: { type: 'Asset', kind: 'Fixed Asset' },
  oasset: { type: 'Asset', kind: 'Other Asset' },
  ap: { type: 'Liability', kind: 'Accounts Payable' },
  ccard: { type: 'Liability', kind: 'Credit Card' },
  ocliab: { type: 'Liability', kind: 'Other Liability' },
  ltliab: { type: 'Liability', kind: 'Notes Payable' },
  inc: { type: 'Revenue', kind: 'Sales' },
  cogs: { type: 'Expense', kind: 'Cost of Goods' },
  exp: { type: 'Expense', kind: 'Operating' },
  exinc: { type: 'Revenue', kind: 'Other Revenue' },
  exexp: { type: 'Expense', kind: 'Other Expense' },
  // Estimates and purchase orders live on non-posting accounts: never balances.
  nonposting: { type: 'skip', kind: 'skip' },
  'non posting': { type: 'skip', kind: 'skip' },
};

const TRIAL_BALANCE: ReportSpec = {
  kind: 'trial_balance',
  title: ['trial balance'],
  implicitKey: true,
  accountCell: true,
  need: ['debit', 'credit'],
  columns: { debit: ['debit'], credit: ['credit'] },
};

const aging = (
  kind: 'aged_receivables' | 'aged_payables',
  titles: string[],
  party: string[],
): ReportSpec => ({
  kind,
  title: titles,
  sections: true,
  need: ['doc', 'party', 'amount'],
  columns: {
    date: ['date'],
    type: ['transaction type', 'type'],
    doc: ['num', 'no', 'number', 'ref no'],
    party: party,
    due: ['due date'],
    original: ['amount'],
    amount: ['open balance'],
  },
});

const SKIP: ReportSpec[] = [
  {
    kind: 'general_ledger',
    title: ['general ledger'],
    need: ['date', 'doc'],
    columns: {
      date: ['date'],
      doc: ['num', 'no'],
      type: ['transaction type', 'type'],
      amount: ['amount'],
      balance: ['balance'],
    },
  },
  {
    kind: 'journal',
    title: ['journal'],
    need: ['date', 'doc'],
    columns: {
      date: ['date'],
      doc: ['num', 'no'],
      debit: ['debit'],
      credit: ['credit'],
    },
  },
  {
    kind: 'profit_and_loss',
    title: ['profit and loss', 'profit loss', 'income statement'],
    implicitKey: true,
    need: ['amount'],
    columns: { amount: ['total'] },
  },
  {
    kind: 'balance_sheet',
    title: ['balance sheet'],
    implicitKey: true,
    need: ['amount'],
    columns: { amount: ['total'] },
  },
];

export const QUICKBOOKS_ONLINE_PROFILE: ReportProfile = {
  source: 'quickbooks_online',
  label: 'QuickBooks Online',
  dateOrder: 'mdy',
  partyCodes: false,
  accountTypes: ACCOUNT_TYPES,
  specs: [
    TRIAL_BALANCE,
    aging(
      'aged_receivables',
      [
        'a r aging detail',
        'a r ageing detail',
        'accounts receivable aging detail',
      ],
      ['customer', 'customer full name', 'name'],
    ),
    aging(
      'aged_payables',
      [
        'a p aging detail',
        'a p ageing detail',
        'accounts payable aging detail',
      ],
      ['vendor', 'supplier', 'name'],
    ),
    {
      kind: 'chart_of_accounts',
      title: ['account list', 'chart of accounts'],
      accountCell: true,
      need: ['key', 'type'],
      columns: {
        key: ['account', 'account name', 'full name', 'name'],
        type: ['type', 'account type'],
        detail: ['detail type'],
      },
    },
    {
      kind: 'customer_list',
      title: ['customer contact list', 'customer list'],
      need: ['key'],
      columns: {
        key: ['customer', 'customer full name', 'display name'],
        phone: ['phone numbers', 'phone', 'mobile'],
        email: ['email'],
        address: ['billing address', 'street address'],
        city: ['city'],
        terms: ['terms'],
      },
    },
    {
      kind: 'vendor_list',
      title: [
        'vendor contact list',
        'supplier contact list',
        'vendor list',
        'supplier list',
      ],
      need: ['key'],
      columns: {
        key: ['vendor', 'supplier', 'display name'],
        phone: ['phone numbers', 'phone'],
        email: ['email'],
        address: ['billing address', 'street address', 'address'],
        city: ['city'],
        terms: ['terms'],
        taxId: ['tax id', 'business id no'],
      },
    },
    {
      kind: 'item_list',
      title: ['product service list', 'products and services'],
      need: ['key', 'price'],
      columns: {
        key: ['product service', 'product service name', 'name'],
        number: ['sku'],
        category: ['type', 'category'],
        price: ['price', 'sales price', 'sales price rate'],
        cost: ['cost', 'purchase cost'],
        qty: ['qty on hand', 'quantity on hand'],
        name: ['description', 'sales description'],
      },
    },
    {
      kind: 'inventory_valuation',
      title: ['inventory valuation summary'],
      implicitKey: true,
      need: ['qty', 'value'],
      columns: {
        number: ['sku'],
        qty: ['qty', 'quantity', 'qty on hand'],
        value: ['asset value'],
        cost: ['calc avg', 'avg cost'],
      },
    },
    ...SKIP,
  ],
};

export const QUICKBOOKS_DESKTOP_PROFILE: ReportProfile = {
  source: 'quickbooks_desktop',
  label: 'QuickBooks Desktop',
  dateOrder: 'mdy',
  partyCodes: false,
  accountTypes: ACCOUNT_TYPES,
  specs: [
    TRIAL_BALANCE,
    aging(
      'aged_receivables',
      ['a r aging detail', 'a r ageing detail'],
      ['name', 'customer'],
    ),
    aging(
      'aged_payables',
      ['a p aging detail', 'a p ageing detail'],
      ['name', 'vendor'],
    ),
    {
      kind: 'inventory_valuation',
      title: ['inventory valuation summary'],
      implicitKey: true,
      need: ['qty', 'value'],
      columns: {
        name: ['item description'],
        qty: ['on hand'],
        value: ['asset value'],
        cost: ['avg cost'],
        price: ['sales price'],
      },
    },
    // IIF lists (File → Utilities → Export → Lists to IIF Files).
    {
      kind: 'chart_of_accounts',
      title: ['accnt'],
      accountCell: true,
      need: ['key', 'type'],
      columns: {
        key: ['name'],
        type: ['accnttype'],
        number: ['accnum'],
        active: ['hidden'],
      },
    },
    {
      kind: 'customer_list',
      title: ['cust'],
      need: ['key'],
      columns: {
        key: ['name'],
        phone: ['phone1'],
        email: ['email'],
        address: ['baddr1'],
        city: ['baddr3'],
        terms: ['terms'],
        creditLimit: ['limit'],
        taxId: ['resalenum'],
      },
    },
    {
      kind: 'vendor_list',
      title: ['vend'],
      need: ['key'],
      columns: {
        key: ['name'],
        phone: ['phone1'],
        email: ['email'],
        address: ['addr1'],
        city: ['addr3'],
        terms: ['terms'],
        taxId: ['taxid'],
      },
    },
    {
      kind: 'item_list',
      title: ['invitem'],
      need: ['key', 'category'],
      columns: {
        key: ['name'],
        category: ['invitemtype'],
        name: ['desc'],
        price: ['price'],
        cost: ['cost'],
      },
    },
    // The same lists as Excel reports.
    {
      kind: 'chart_of_accounts',
      title: ['account listing'],
      accountCell: true,
      need: ['key', 'type'],
      columns: { key: ['account'], type: ['type'] },
    },
    ...SKIP,
  ],
};
