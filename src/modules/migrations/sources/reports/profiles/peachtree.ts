/**
 * Peachtree / Sage 50 US reports exported to Excel ("Excel" on the report
 * window, Sage 50 layout), any version: the reports-only route, for versions
 * whose backup FinMatrix cannot read and for owners who prefer reports.
 *
 * Column titles as Sage 50 prints them (Reports & Forms). The four reports
 * that prove a backup (TB, aged receivables/payables, inventory valuation)
 * are the same reports this profile reads.
 */
import { ReportProfile } from '../report-engine';

export const PEACHTREE_PROFILE: ReportProfile = {
  source: 'peachtree',
  label: 'Peachtree / Sage 50',
  dateOrder: 'mdy',
  specs: [
    {
      kind: 'trial_balance',
      need: ['key', 'debit', 'credit'],
      columns: {
        key: ['account id'],
        name: ['account description', 'description'],
        debit: ['debit amt', 'debit amount', 'debit'],
        credit: ['credit amt', 'credit amount', 'credit'],
      },
    },
    {
      kind: 'aged_receivables',
      grouped: true,
      need: ['key', 'doc', 'amount'],
      columns: {
        key: ['customer id'],
        name: ['customer', 'customer name'],
        doc: ['invoice cm', 'invoice cm no', 'invoice', 'reference'],
        date: ['date', 'invoice date'],
        amount: ['amount due'],
      },
    },
    {
      kind: 'aged_payables',
      grouped: true,
      need: ['key', 'doc', 'amount'],
      columns: {
        key: ['vendor id'],
        name: ['vendor', 'vendor name'],
        doc: ['invoice cm', 'invoice cm no', 'invoice', 'reference'],
        date: ['date', 'invoice date'],
        amount: ['amount due'],
      },
    },
    {
      kind: 'inventory_valuation',
      need: ['key', 'qty', 'value'],
      columns: {
        key: ['item id'],
        name: ['item description', 'description'],
        unit: ['stocking u m', 'stocking um', 'u m'],
        qty: ['qty on hand', 'quantity on hand'],
        value: ['item value', 'value'],
        cost: ['avg cost', 'unit cost'],
      },
    },
    {
      kind: 'chart_of_accounts',
      need: ['key', 'name', 'type'],
      columns: {
        key: ['account id'],
        name: ['account description', 'description'],
        type: ['account type', 'type'],
        active: ['active'],
      },
    },
    {
      kind: 'customer_list',
      need: ['key', 'name'],
      title: ['customer list'],
      columns: {
        key: ['customer id'],
        name: ['customer name', 'customer', 'name'],
        phone: ['telephone 1', 'telephone', 'phone'],
        city: ['bill to city', 'city'],
        terms: ['terms'],
        creditLimit: ['credit limit'],
        taxId: ['resale no', 'tax id'],
        email: ['e mail', 'email'],
        address: ['bill to address line one', 'address line 1', 'address'],
      },
    },
    {
      kind: 'vendor_list',
      need: ['key', 'name'],
      title: ['vendor list'],
      columns: {
        key: ['vendor id'],
        name: ['vendor name', 'vendor', 'name'],
        phone: ['telephone 1', 'telephone', 'phone'],
        city: ['city'],
        terms: ['terms'],
        taxId: ['tax id', '1099 type'],
        email: ['e mail', 'email'],
        address: ['address line 1', 'address'],
      },
    },
    {
      kind: 'item_list',
      need: ['key', 'name'],
      title: ['item list'],
      columns: {
        key: ['item id'],
        name: ['item description', 'description'],
        category: ['item type', 'item class'],
        unit: ['stocking u m', 'stocking um', 'u m'],
        price: ['sales price 1', 'price level 1', 'sales price'],
        cost: ['last unit cost', 'unit cost'],
        qty: ['qty on hand', 'quantity on hand'],
      },
    },
  ],
  // Sage 50 US account types.
  accountTypes: {
    cash: { type: 'Asset', kind: 'Bank' },
    'accounts receivable': { type: 'Asset', kind: 'Accounts Receivable' },
    inventory: { type: 'Asset', kind: 'Inventory' },
    'other current assets': { type: 'Asset', kind: 'Other Asset' },
    'fixed assets': { type: 'Asset', kind: 'Fixed Asset' },
    'accumulated depreciation': { type: 'Asset', kind: 'Fixed Asset' },
    'other assets': { type: 'Asset', kind: 'Other Asset' },
    'accounts payable': { type: 'Liability', kind: 'Accounts Payable' },
    'other current liabilities': { type: 'Liability', kind: 'Other Liability' },
    'long term liabilities': { type: 'Liability', kind: 'Notes Payable' },
    'equity doesn t close': { type: 'Equity', kind: 'Owner Equity' },
    'equity gets closed': { type: 'Equity', kind: 'Owner Draws' },
    'equity retained earnings': { type: 'Equity', kind: 'Retained Earnings' },
    income: { type: 'Revenue', kind: 'Sales' },
    'cost of sales': { type: 'Expense', kind: 'Cost of Goods' },
    expenses: { type: 'Expense', kind: 'Operating' },
  },
};
