/**
 * Xero and Zoho Books exports.
 *
 * Xero: Accounting → Chart of accounts → Export (CSV); Contacts → Export
 * (CSV); Products and services → Export (CSV: codes and prices, no
 * quantities); reports (Trial Balance, Aged Receivables Detail, Aged
 * Payables Detail, Inventory Item List — quantity and value on hand) →
 * Export → Excel. Aged detail is grouped by contact (a heading row),
 * accounts may read "Sales (200)", and the trial balance's year-to-date
 * columns carry the profit-and-loss figures.
 *
 * Zoho Books: each list page → More → Export (Chart of Accounts, Customers,
 * Vendors, Items; CSV or XLSX) and reports (Trial Balance, AR/AP Aging
 * Details, Inventory Valuation Summary) → Export → XLSX or CSV. The data
 * backup (Settings → Data Management) is always password-protected: its
 * CSVs are read once taken out of it, and its invoice and bill lists are
 * recognised and skipped.
 *
 * Both identify contacts by name; FinMatrix gives them codes.
 */
import { ReportProfile, ReportSpec } from '../report-engine';

const XERO_TYPES: ReportProfile['accountTypes'] = {
  bank: { type: 'Asset', kind: 'Bank' },
  'current asset': { type: 'Asset', kind: 'Other Asset' },
  'current assets': { type: 'Asset', kind: 'Other Asset' },
  inventory: { type: 'Asset', kind: 'Inventory' },
  'fixed asset': { type: 'Asset', kind: 'Fixed Asset' },
  'fixed assets': { type: 'Asset', kind: 'Fixed Asset' },
  'non current asset': { type: 'Asset', kind: 'Other Asset' },
  prepayment: { type: 'Asset', kind: 'Prepaid' },
  'current liability': { type: 'Liability', kind: 'Other Liability' },
  'current liabilities': { type: 'Liability', kind: 'Other Liability' },
  liability: { type: 'Liability', kind: 'Other Liability' },
  'non current liability': { type: 'Liability', kind: 'Notes Payable' },
  equity: { type: 'Equity', kind: 'Owner Equity' },
  depreciation: { type: 'Expense', kind: 'Depreciation' },
  'direct costs': { type: 'Expense', kind: 'Cost of Goods' },
  expense: { type: 'Expense', kind: 'Operating' },
  overhead: { type: 'Expense', kind: 'Operating' },
  overheads: { type: 'Expense', kind: 'Operating' },
  'other income': { type: 'Revenue', kind: 'Other Revenue' },
  revenue: { type: 'Revenue', kind: 'Sales' },
  sales: { type: 'Revenue', kind: 'Sales' },
};

const ZOHO_TYPES: ReportProfile['accountTypes'] = {
  cash: { type: 'Asset', kind: 'Cash' },
  bank: { type: 'Asset', kind: 'Bank' },
  'accounts receivable': { type: 'Asset', kind: 'Accounts Receivable' },
  stock: { type: 'Asset', kind: 'Inventory' },
  'other current asset': { type: 'Asset', kind: 'Other Asset' },
  'fixed asset': { type: 'Asset', kind: 'Fixed Asset' },
  'other asset': { type: 'Asset', kind: 'Other Asset' },
  'accounts payable': { type: 'Liability', kind: 'Accounts Payable' },
  'credit card': { type: 'Liability', kind: 'Credit Card' },
  'other current liability': { type: 'Liability', kind: 'Other Liability' },
  'long term liability': { type: 'Liability', kind: 'Notes Payable' },
  'other liability': { type: 'Liability', kind: 'Other Liability' },
  equity: { type: 'Equity', kind: 'Owner Equity' },
  income: { type: 'Revenue', kind: 'Sales' },
  'other income': { type: 'Revenue', kind: 'Other Revenue' },
  'cost of goods sold': { type: 'Expense', kind: 'Cost of Goods' },
  expense: { type: 'Expense', kind: 'Operating' },
  'other expense': { type: 'Expense', kind: 'Other Expense' },
};

const xeroAged = (kind: 'aged_receivables' | 'aged_payables', titles: string[]): ReportSpec => ({
  kind,
  title: titles,
  sections: true,
  partyFromSection: true,
  need: ['doc', 'amount'],
  columns: {
    date: ['invoice date', 'date'],
    doc: ['invoice number', 'number', 'invoice reference', 'reference', 'transaction'],
    due: ['due date'],
    amount: ['total', 'amount due', 'balance due', 'due'],
  },
});

export const XERO_PROFILE: ReportProfile = {
  source: 'xero',
  label: 'Xero',
  dateOrder: 'dmy',
  partyCodes: false,
  accountTypes: XERO_TYPES,
  specs: [
    {
      kind: 'trial_balance',
      title: ['trial balance'],
      accountCell: true,
      need: ['key', 'debit', 'credit'],
      columns: {
        key: ['account'],
        number: ['account code', 'code'],
        type: ['account type'],
        debit: ['debit'],
        credit: ['credit'],
        ytdDebit: ['ytd debit', 'debit year to date'],
        ytdCredit: ['ytd credit', 'credit year to date'],
      },
    },
    xeroAged('aged_receivables', ['aged receivables detail', 'aged receivables']),
    xeroAged('aged_payables', ['aged payables detail', 'aged payables']),
    {
      kind: 'chart_of_accounts',
      need: ['key', 'name', 'type'],
      columns: { key: ['code', 'account code'], name: ['name', 'account name'], type: ['type', 'account type'] },
    },
    {
      kind: 'contact_list',
      need: ['key'],
      columns: {
        key: ['contactname', 'contact name'],
        number: ['accountnumber', 'account number'],
        email: ['emailaddress', 'email address', 'email'],
        phone: ['phonenumber', 'phone number', 'mobilenumber'],
        address: ['poaddressline1', 'saaddressline1', 'address line 1'],
        city: ['pocity', 'sacity', 'city'],
        taxId: ['taxnumber', 'tax number'],
      },
    },
    {
      kind: 'item_list',
      need: ['key', 'price'],
      columns: {
        key: ['itemcode', 'item code', 'code'],
        name: ['itemname', 'item name', 'name'],
        price: ['salesunitprice', 'sales unit price', 'sell price'],
        cost: ['purchasesunitprice', 'purchases unit price', 'cost price'],
      },
    },
    {
      kind: 'inventory_valuation',
      // The Inventory Item List gives quantity and value on hand; the
      // Inventory Item Summary is read when it shows the closing figures.
      title: ['inventory item list', 'inventory item summary', 'inventory summary'],
      need: ['key', 'qty', 'value'],
      columns: {
        key: ['item code', 'code', 'item'],
        name: ['item name', 'description'],
        qty: ['quantity on hand', 'closing quantity', 'closing qty', 'quantity', 'qty'],
        value: ['value on hand', 'closing value', 'total value', 'asset value', 'value'],
        cost: ['average cost', 'avg cost', 'cost'],
      },
    },
  ],
};

export const ZOHO_BOOKS_PROFILE: ReportProfile = {
  source: 'zoho_books',
  label: 'Zoho Books',
  dateOrder: 'dmy',
  partyCodes: false,
  accountTypes: ZOHO_TYPES,
  specs: [
    {
      kind: 'trial_balance',
      title: ['trial balance'],
      need: ['key', 'debit', 'credit'],
      columns: {
        key: ['account code', 'code'],
        name: ['account', 'account name'],
        debit: ['net debit', 'debit'],
        credit: ['net credit', 'credit'],
      },
    },
    {
      kind: 'aged_receivables',
      title: ['ar aging details', 'ar ageing details', 'ar aging detail'],
      sections: true,
      need: ['doc', 'party', 'amount'],
      columns: {
        date: ['date'],
        doc: ['transaction', 'transaction no', 'transaction number', 'invoice number'],
        type: ['type'],
        party: ['customer name', 'customer'],
        original: ['amount', 'total'],
        amount: ['balance due', 'balance', 'amount due'],
      },
    },
    {
      kind: 'aged_payables',
      title: ['ap aging details', 'ap ageing details', 'ap aging detail'],
      sections: true,
      need: ['doc', 'party', 'amount'],
      columns: {
        date: ['date'],
        doc: ['transaction', 'transaction no', 'transaction number', 'bill number'],
        type: ['type'],
        party: ['vendor name', 'vendor', 'supplier name'],
        original: ['amount', 'total'],
        amount: ['balance due', 'balance', 'amount due'],
      },
    },
    {
      kind: 'chart_of_accounts',
      need: ['key', 'name', 'type'],
      columns: { key: ['account code', 'code'], name: ['account name', 'name'], type: ['account type', 'type'] },
    },
    // Contacts from the data backup carry a Contact Type; the Customers and
    // Vendors pages export each list on its own, named for its page.
    {
      kind: 'contact_list',
      need: ['key'],
      columns: {
        key: ['display name'],
        contactType: ['contact type', 'type'],
        email: ['email id', 'email', 'emailid'],
        phone: ['phone', 'mobile phone', 'mobilephone'],
        city: ['billing city', 'city'],
        terms: ['payment terms', 'payment terms label'],
        creditLimit: ['credit limit'],
        taxId: ['tax registration number', 'trn', 'ntn', 'gst identification number gstin'],
      },
    },
    {
      kind: 'item_list',
      need: ['key', 'price'],
      columns: {
        key: ['sku', 'item code'],
        name: ['item name', 'name'],
        price: ['rate', 'selling price'],
        cost: ['purchase rate', 'cost price'],
        unit: ['usage unit', 'unit'],
      },
    },
    {
      kind: 'inventory_valuation',
      title: ['inventory valuation summary', 'inventory valuation'],
      need: ['key', 'qty', 'value'],
      columns: {
        key: ['sku', 'item code'],
        name: ['item name', 'item'],
        qty: ['stock on hand', 'quantity on hand', 'quantity'],
        value: ['inventory asset value', 'asset value', 'value'],
      },
    },
    // The backup's Invoice.csv and Bill.csv list every document line, paid
    // or not: the aging reports carry what is open.
    { kind: 'transactions', need: ['doc', 'status'], columns: { doc: ['invoice number'], status: ['invoice status'] } },
    { kind: 'transactions', need: ['doc', 'status'], columns: { doc: ['bill number'], status: ['bill status'] } },
  ],
};
