/**
 * The sample books as Xero and Zoho Books export them.
 *
 * Xero: chart, contacts and items as CSV; trial balance with as-at and
 * year-to-date columns under section headings; aged detail grouped by
 * contact. Zoho Books: the chart, customers, vendors and items exported
 * from their list pages, and its reports, aged detail grouped by bucket.
 */
import Decimal from 'decimal.js';
import * as ExcelJS from 'exceljs';
import { fmtDate, money, SampleBooks } from '../books';

const D = (v: Decimal.Value) => new Decimal(v);
const num = (v: Decimal.Value) => Number(money(v));
const toBuffer = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());
const partyName = (b: SampleBooks, code: string) => [...b.customers, ...b.vendors].find((p) => p.code === code)!.name;
const csv = (rows: Array<Array<string | number | null>>) =>
  rows.map((r) => r.map((v) => (v === null ? '' : `"${String(v).replace(/"/g, '""')}"`)).join(',')).join('\r\n') + '\r\n';
const longDmy = (iso: string) => {
  const m = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(iso.slice(5, 7)) - 1];
  return `${Number(iso.slice(8, 10))} ${m} ${iso.slice(0, 4)}`;
};
async function report(lines: Array<Array<string | number | null>>, header: string[], rows: Array<Array<string | number | null>>) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Report');
  for (const l of lines) ws.addRow(l);
  ws.addRow([]);
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  return toBuffer(wb);
}
const stockBySku = (b: SampleBooks) => {
  const m = new Map<string, Decimal>();
  for (const s of b.stock) m.set(s.sku, (m.get(s.sku) ?? D(0)).plus(s.qty));
  return m;
};

const XERO_TYPE: Record<string, string> = {
  Cash: 'Bank',
  Bank: 'Bank',
  'Accounts Receivable': 'Current Asset',
  Inventory: 'Inventory',
  Prepaid: 'Prepayment',
  'Fixed Asset': 'Fixed Asset',
  'Accounts Payable': 'Current Liability',
  'Tax Payable': 'Current Liability',
  'Other Liability': 'Current Liability',
  'Notes Payable': 'Non-current Liability',
  'Owner Equity': 'Equity',
  'Retained Earnings': 'Equity',
  Sales: 'Revenue',
  'Cost of Goods': 'Direct Costs',
  Payroll: 'Expense',
  Operating: 'Overhead',
  Depreciation: 'Depreciation',
  'Other Expense': 'Expense',
};
const SECTION: Record<string, string> = { Revenue: 'Revenue', Expense: 'Expenses', Asset: 'Assets', Liability: 'Liabilities', Equity: 'Equity' };

export async function xeroFiles(b: SampleBooks): Promise<Record<string, Buffer | string>> {
  const chart = csv([
    ['*Code', '*Name', '*Type', '*Tax Code', 'Description', 'Dashboard', 'Expense Claims', 'Enable Payments'],
    ...b.accounts.map((a) => [a.number, a.name, XERO_TYPE[a.kind], 'No VAT', '', 'No', 'No', 'No']),
  ]);
  const contacts = csv([
    ['ContactName', 'AccountNumber', 'EmailAddress', 'FirstName', 'LastName', 'POAddressLine1', 'POCity', 'PhoneNumber', 'MobileNumber', 'TaxNumber'],
    ...[...b.customers, ...b.vendors].map((p) => [p.name, p.code, p.email, '', '', p.address, p.city, p.phone, '', p.ntn]),
  ]);
  const qty = stockBySku(b);
  const items = csv([
    ['*ItemCode', 'ItemName', 'PurchasesDescription', 'PurchasesUnitPrice', 'PurchasesAccount', 'SalesDescription', 'SalesUnitPrice', 'SalesAccount', 'InventoryAssetAccount', 'CostOfGoodsSoldAccount'],
    ...b.items.map((i) => [i.sku, i.name, i.name, i.cost, '5000', i.name, i.price, '4000', '1200', '5000']),
  ]);

  // Trial balance: September's movement in Debit/Credit for profit and loss,
  // balances in the year-to-date pair (the pair that balances).
  const rows: Array<Array<string | number | null>> = [];
  const tot = [D(0), D(0), D(0), D(0)];
  for (const type of ['Revenue', 'Expense', 'Asset', 'Liability', 'Equity'] as const) {
    const accts = b.accounts.filter((a) => a.type === type && !D(b.balances.get(a.number) ?? 0).isZero());
    if (!accts.length) continue;
    rows.push([SECTION[type]]);
    for (const a of accts) {
      const ytd = D(b.balances.get(a.number)!);
      const month = type === 'Revenue' || type === 'Expense' ? ytd.dividedBy(3).toDecimalPlaces(2) : ytd;
      const cells = [month.greaterThan(0) ? month : null, month.lessThan(0) ? month.negated() : null, ytd.greaterThan(0) ? ytd : null, ytd.lessThan(0) ? ytd.negated() : null];
      cells.forEach((c, i) => c && (tot[i] = tot[i].plus(c)));
      rows.push([a.name, a.number, XERO_TYPE[a.kind], ...cells.map((c) => (c ? num(c) : null))]);
    }
  }
  rows.push(['Total', '', '', ...tot.map((t) => num(t))]);
  const tb = await report([['Trial Balance'], [b.company], [`As at ${longDmy(b.openingDate)}`]], ['Account', 'Account Code', 'Account Type', 'Debit', 'Credit', 'YTD Debit', 'YTD Credit'], rows);

  const aged = (parties: SampleBooks['customers'], docs: SampleBooks['invoices']) => {
    const out: Array<Array<string | number | null>> = [];
    let total = D(0);
    for (const p of parties) {
      const mine = docs.filter((d) => d.party === p.code);
      if (!mine.length) continue;
      out.push([p.name]);
      let sub = D(0);
      for (const d of mine) {
        const days = Math.round((Date.parse(b.openingDate) - Date.parse(d.due)) / 86400000);
        const bucket = days <= 0 ? 4 : days <= 30 ? 5 : days <= 60 ? 6 : days <= 90 ? 7 : 8;
        const cells: Array<number | null> = [null, null, null, null, null];
        cells[bucket - 4] = num(d.open);
        out.push([fmtDate.dmy(d.date), d.number, '', fmtDate.dmy(d.due), ...cells, num(d.open)]);
        sub = sub.plus(d.open);
      }
      out.push([`Total ${p.name}`, '', '', '', null, null, null, null, null, num(sub)]);
      total = total.plus(sub);
    }
    out.push(['Total', '', '', '', null, null, null, null, null, num(total)]);
    return out;
  };
  const head = ['Invoice Date', 'Invoice Number', 'Invoice Reference', 'Due Date', 'Current', '< 1 Month', '1 Month', '2 Months', 'Older', 'Total'];
  const ar = await report([['Aged Receivables Detail'], [b.company], [`As at ${longDmy(b.openingDate)}`]], head, aged(b.customers, b.invoices));
  const ap = await report([['Aged Payables Detail'], [b.company], [`As at ${longDmy(b.openingDate)}`]], head, aged(b.vendors, b.bills));

  let tq = D(0);
  let tv = D(0);
  const ivRows: Array<Array<string | number | null>> = b.items
    .filter((i) => qty.has(i.sku))
    .map((i) => {
      const q = qty.get(i.sku)!;
      tq = tq.plus(q);
      tv = tv.plus(q.times(i.cost));
      return [i.sku, i.name, num(q), num(i.cost), num(q.times(i.cost))];
    });
  ivRows.push(['Total', '', num(tq), null, num(tv)]);
  const iv = await report([['Inventory Item List'], [b.company], [`As at ${longDmy(b.openingDate)}`]], ['Item Code', 'Item Name', 'Quantity On Hand', 'Average Cost', 'Value On Hand'], ivRows);
  return {
    'ChartOfAccounts.csv': chart,
    'Contacts.csv': contacts,
    'InventoryItems.csv': items,
    'Trial Balance.xlsx': tb,
    'Aged Receivables Detail.xlsx': ar,
    'Aged Payables Detail.xlsx': ap,
    'Inventory Item List.xlsx': iv,
  };
}

const ZOHO_TYPE: Record<string, string> = {
  Cash: 'Cash',
  Bank: 'Bank',
  'Accounts Receivable': 'Accounts Receivable',
  Inventory: 'Stock',
  Prepaid: 'Other Current Asset',
  'Fixed Asset': 'Fixed Asset',
  'Accounts Payable': 'Accounts Payable',
  'Tax Payable': 'Other Current Liability',
  'Other Liability': 'Other Current Liability',
  'Notes Payable': 'Long Term Liability',
  'Owner Equity': 'Equity',
  'Retained Earnings': 'Equity',
  Sales: 'Income',
  'Cost of Goods': 'Cost Of Goods Sold',
  Payroll: 'Expense',
  Operating: 'Expense',
  Depreciation: 'Expense',
  'Other Expense': 'Other Expense',
};

export async function zohoFiles(b: SampleBooks): Promise<Record<string, Buffer>> {
  // Each list page → More → Export, as CSV. (The data backup is always
  // password-protected, so the guide uses these instead.)
  const chart = csv([['Account Name', 'Account Code', 'Description', 'Account Type', 'Account Status', 'Currency', 'Parent Account'], ...b.accounts.map((a) => [a.name, a.number, '', ZOHO_TYPE[a.kind], 'Active', 'PKR', ''])]);
  const contactHead = ['Display Name', 'Company Name', 'First Name', 'Last Name', 'EmailID', 'Phone', 'Billing City', 'Payment Terms Label'];
  const customers = csv([[...contactHead, 'Credit Limit'], ...b.customers.map((c) => [c.name, c.name, '', '', c.email, c.phone, c.city, c.terms, c.creditLimit])]);
  const vendors = csv([contactHead, ...b.vendors.map((v) => [v.name, v.name, '', '', v.email, v.phone, v.city, v.terms])]);
  const qty = stockBySku(b);
  const items = csv([['Item Name', 'SKU', 'Description', 'Rate', 'Purchase Rate', 'Usage unit', 'Item Type', 'Stock On Hand'], ...b.items.map((i) => [i.name, i.sku, '', i.price, i.cost, i.unit, 'Inventory', (qty.get(i.sku) ?? D(0)).toString()])]);

  const title = (t: string) => [[b.company], [t], [`As of ${fmtDate.dmy(b.openingDate)}`]];
  const tbRows: Array<Array<string | number | null>> = [];
  let dr = D(0);
  let cr = D(0);
  for (const [section, types] of [['Assets', ['Asset']], ['Liabilities & Equities', ['Liability', 'Equity']], ['Income', ['Revenue']], ['Expense', ['Expense']]] as const) {
    tbRows.push([section]);
    for (const a of b.accounts.filter((x) => (types as readonly string[]).includes(x.type))) {
      const v = D(b.balances.get(a.number) ?? 0);
      if (v.isZero()) continue;
      tbRows.push([a.name, a.number, v.greaterThan(0) ? num(v) : null, v.lessThan(0) ? num(v.negated()) : null]);
      if (v.greaterThan(0)) dr = dr.plus(v);
      else cr = cr.minus(v);
    }
  }
  tbRows.push(['Total', '', num(dr), num(cr)]);
  const tb = await report(title('Trial Balance'), ['Account', 'Account Code', 'Net Debit', 'Net Credit'], tbRows);

  const aging = (docs: SampleBooks['invoices'], kind: 'Invoice' | 'Bill') => {
    const out: Array<Array<string | number | null>> = [];
    const buckets = ['Current', '1 - 15 Days', '16 - 30 Days', '31 - 45 Days', '> 45 Days'];
    const of = (d: SampleBooks['invoices'][number]) => {
      const days = Math.round((Date.parse(b.openingDate) - Date.parse(d.due)) / 86400000);
      return days <= 0 ? 0 : days <= 15 ? 1 : days <= 30 ? 2 : days <= 45 ? 3 : 4;
    };
    let total = D(0);
    let totalOrig = D(0);
    buckets.forEach((bucket, i) => {
      const mine = docs.filter((d) => of(d) === i);
      if (!mine.length) return;
      out.push([bucket]);
      let sub = D(0);
      let subOrig = D(0);
      for (const d of mine) {
        out.push([fmtDate.dmy(d.date), d.number, kind, D(d.open).lessThan(d.original) ? 'Partially Paid' : 'Overdue', partyName(b, d.party), Math.max(0, Math.round((Date.parse(b.openingDate) - Date.parse(d.due)) / 86400000)), num(d.original), num(d.open)]);
        sub = sub.plus(d.open);
        subOrig = subOrig.plus(d.original);
      }
      out.push([`Total for ${bucket}`, '', '', '', '', null, num(subOrig), num(sub)]);
      total = total.plus(sub);
      totalOrig = totalOrig.plus(subOrig);
    });
    out.push(['Total', '', '', '', '', null, num(totalOrig), num(total)]);
    return out;
  };
  const ar = await report(title('AR Aging Details'), ['Date', 'Transaction#', 'Type', 'Status', 'Customer Name', 'Age', 'Amount', 'Balance Due'], aging(b.invoices, 'Invoice'));
  const ap = await report(title('AP Aging Details'), ['Date', 'Transaction#', 'Type', 'Status', 'Vendor Name', 'Age', 'Amount', 'Balance Due'], aging(b.bills, 'Bill'));
  let tq = D(0);
  let tv = D(0);
  const ivRows: Array<Array<string | number | null>> = b.items
    .filter((i) => qty.has(i.sku))
    .map((i) => {
      const q = qty.get(i.sku)!;
      tq = tq.plus(q);
      tv = tv.plus(q.times(i.cost));
      return [i.name, i.sku, num(q), num(q.times(i.cost))];
    });
  ivRows.push(['Total', '', num(tq), num(tv)]);
  const iv = await report(title('Inventory Valuation Summary'), ['Item Name', 'SKU', 'Stock On Hand', 'Inventory Asset Value'], ivRows);
  return {
    'Chart of Accounts.csv': Buffer.from(chart),
    'Customers.csv': Buffer.from(customers),
    'Vendors.csv': Buffer.from(vendors),
    'Items.csv': Buffer.from(items),
    'Trial Balance.xlsx': tb,
    'AR Aging Details.xlsx': ar,
    'AP Aging Details.xlsx': ap,
    'Inventory Valuation Summary.xlsx': iv,
  };
}
