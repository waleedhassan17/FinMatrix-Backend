/**
 * The sample books as QuickBooks Online and QuickBooks Desktop export them.
 *
 * Online: accounts without numbers (its default), customers and vendors by
 * name, aged detail grouped by aging bucket, an "Export data" ZIP with
 * reports FinMatrix must recognise and skip (general ledger, journal, P&L,
 * balance sheet). Desktop: lists as IIF (one non-posting account and one job
 * among them), reports as Excel with QuickBooks' header block, the trial
 * balance as CSV with QuickBooks' two-digit-year date.
 */
import AdmZip from 'adm-zip';
import Decimal from 'decimal.js';
import * as ExcelJS from 'exceljs';
import { fmtDate, money, SampleAccount, SampleBooks } from '../books';

const D = (v: Decimal.Value) => new Decimal(v);
const num = (v: Decimal.Value) => Number(money(v));
const toBuffer = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());
const longDate = (iso: string) => {
  const m = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(iso.slice(5, 7)) - 1];
  return `${m} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
};
const partyName = (b: SampleBooks, code: string) => [...b.customers, ...b.vendors].find((p) => p.code === code)!.name;

/** A report as QuickBooks writes it: company, title, date line, blank, header. */
async function qbReport(b: SampleBooks, title: string, dateLine: string | null, header: Array<string | null>, rows: Array<Array<string | number | null>>, footer = true) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title.slice(0, 31).replace(/[/\\?*[\]:]/g, '_'));
  ws.addRow([b.company]);
  ws.addRow([title]);
  if (dateLine) ws.addRow([dateLine]);
  ws.addRow([]);
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  if (footer) {
    ws.addRow([]);
    ws.addRow([`Wednesday, Oct 01, 2026 09:15 AM GMT+05:00`]);
  }
  return toBuffer(wb);
}

const QBO_TYPE: Record<string, [string, string]> = {
  Cash: ['Bank', 'Cash on hand'],
  Bank: ['Bank', 'Checking'],
  'Accounts Receivable': ['Accounts receivable (A/R)', 'Accounts Receivable (A/R)'],
  Inventory: ['Other Current Assets', 'Inventory'],
  Prepaid: ['Other Current Assets', 'Prepaid Expenses'],
  'Fixed Asset': ['Fixed Assets', 'Machinery & Equipment'],
  'Accounts Payable': ['Accounts payable (A/P)', 'Accounts Payable (A/P)'],
  'Tax Payable': ['Other Current Liabilities', 'Sales Tax Payable'],
  'Other Liability': ['Other Current Liabilities', 'Other Current Liabilities'],
  'Notes Payable': ['Long Term Liabilities', 'Notes Payable'],
  'Owner Equity': ['Equity', "Owner's Equity"],
  'Retained Earnings': ['Equity', 'Retained Earnings'],
  Sales: ['Income', 'Sales of Product Income'],
  'Cost of Goods': ['Cost of Goods Sold', 'Supplies & Materials - COGS'],
  Payroll: ['Expenses', 'Payroll Expenses'],
  Operating: ['Expenses', 'Utilities'],
  Depreciation: ['Expenses', 'Depreciation'],
  'Other Expense': ['Other Expense', 'Other Miscellaneous Expense'],
};
const IIF_TYPE: Record<string, string> = {
  Cash: 'BANK',
  Bank: 'BANK',
  'Accounts Receivable': 'AR',
  Inventory: 'OCASSET',
  Prepaid: 'OCASSET',
  'Fixed Asset': 'FIXASSET',
  'Accounts Payable': 'AP',
  'Tax Payable': 'OCLIAB',
  'Other Liability': 'OCLIAB',
  'Notes Payable': 'LTLIAB',
  'Owner Equity': 'EQUITY',
  'Retained Earnings': 'EQUITY',
  Sales: 'INC',
  'Cost of Goods': 'COGS',
  Payroll: 'EXP',
  Operating: 'EXP',
  Depreciation: 'EXP',
  'Other Expense': 'EXEXP',
};

function trialBalanceRows(b: SampleBooks, label: (a: SampleAccount) => string) {
  const rows: Array<Array<string | number | null>> = [];
  let dr = D(0);
  let cr = D(0);
  for (const a of b.accounts) {
    const v = D(b.balances.get(a.number) ?? 0);
    if (v.isZero()) continue;
    rows.push([label(a), v.greaterThan(0) ? num(v) : null, v.lessThan(0) ? num(v.negated()) : null]);
    if (v.greaterThan(0)) dr = dr.plus(v);
    else cr = cr.minus(v);
  }
  return { rows, dr, cr };
}

/** Aged detail grouped by aging bucket ("Current", "1 - 30 days past due"…), customer on each line. */
function agingRows(b: SampleBooks, docs: SampleBooks['invoices'], type: string, desktop: boolean) {
  const buckets = desktop
    ? ['Current', '1 - 30', '31 - 60', '61 - 90', '> 90']
    : ['Current', '1 - 30 days past due', '31 - 60 days past due', '61 - 90 days past due', '91 or more days past due'];
  const pastDue = (d: SampleBooks['invoices'][number]) => Math.round((Date.parse(b.openingDate) - Date.parse(d.due)) / 86400000);
  const bucketOf = (d: SampleBooks['invoices'][number]) => {
    const p = pastDue(d);
    return p <= 0 ? 0 : p <= 30 ? 1 : p <= 60 ? 2 : p <= 90 ? 3 : 4;
  };
  const rows: Array<Array<string | number | null>> = [];
  let open = D(0);
  let orig = D(0);
  buckets.forEach((bucket, i) => {
    const mine = docs.filter((d) => bucketOf(d) === i);
    if (!mine.length) return;
    rows.push([bucket]);
    let o = D(0);
    let a = D(0);
    for (const d of mine) {
      const who = d.job ?? partyName(b, d.party);
      rows.push(
        desktop
          ? ['', type, fmtDate.mdy(d.date), d.number, '', who, '', fmtDate.mdy(d.due), '', Math.max(0, pastDue(d)), num(d.open)]
          : ['', fmtDate.mdy(d.date), type, d.number, who, fmtDate.mdy(d.due), Math.max(0, pastDue(d)), num(d.original), num(d.open)],
      );
      o = o.plus(d.open);
      a = a.plus(d.original);
    }
    rows.push(desktop ? [`Total ${bucket}`, '', '', '', '', '', '', '', '', '', num(o)] : [`Total for ${bucket}`, '', '', '', '', '', '', num(a), num(o)]);
    open = open.plus(o);
    orig = orig.plus(a);
  });
  rows.push(desktop ? ['TOTAL', '', '', '', '', '', '', '', '', '', num(open)] : ['TOTAL', '', '', '', '', '', '', num(orig), num(open)]);
  return rows;
}

const stockBySku = (b: SampleBooks) => {
  const m = new Map<string, Decimal>();
  for (const s of b.stock) m.set(s.sku, (m.get(s.sku) ?? D(0)).plus(s.qty));
  return m;
};

// ── QuickBooks Online ────────────────────────────────────────────────────
export async function quickbooksOnline(b: SampleBooks): Promise<Record<string, Buffer>> {
  const asOf = `As of ${longDate(b.openingDate)}`;
  const tb = trialBalanceRows(b, (a) => a.name);
  const trialBalance = await qbReport(b, 'Trial Balance', asOf, ['', 'Debit', 'Credit'], [...tb.rows, ['TOTAL', num(tb.dr), num(tb.cr)]]);
  const accountList = await qbReport(
    b,
    'Account List',
    null,
    ['Account', 'Type', 'Detail Type', 'Description', 'Balance'],
    b.accounts.map((a) => {
      const [type, detail] = a.number === '1590' ? ['Fixed Assets', 'Accumulated Depreciation'] : QBO_TYPE[a.kind];
      const bal = D(b.balances.get(a.number) ?? 0);
      return [a.name, type, detail, '', ['Revenue', 'Expense'].includes(a.type) ? null : num(a.type === 'Asset' ? bal : bal.negated())];
    }),
  );
  const ar = await qbReport(b, 'A/R Aging Detail', asOf, ['', 'Date', 'Transaction Type', 'Num', 'Customer', 'Due Date', 'Past Due', 'Amount', 'Open Balance'], agingRows(b, b.invoices, 'Invoice', false));
  const ap = await qbReport(b, 'A/P Aging Detail', asOf, ['', 'Date', 'Transaction Type', 'Num', 'Vendor', 'Due Date', 'Past Due', 'Amount', 'Open Balance'], agingRows(b, b.bills, 'Bill', false));
  const customers = await qbReport(b, 'Customer Contact List', null, ['Customer', 'Phone Numbers', 'Email', 'Full Name', 'Billing Address', 'Shipping Address'], b.customers.map((c) => [c.name, `Mobile: ${c.phone}`, c.email, '', `${c.address}, ${c.city}`, '']));
  const vendors = await qbReport(b, 'Vendor Contact List', null, ['Vendor', 'Phone Numbers', 'Email', 'Full Name', 'Address', 'Account #'], b.vendors.map((v) => [v.name, `Phone: ${v.phone}`, v.email, '', `${v.address}, ${v.city}`, '']));
  const qty = stockBySku(b);
  const products = await qbReport(
    b,
    'Product/Service List',
    null,
    ['Product/Service', 'Type', 'Description', 'Price', 'Cost', 'Qty On Hand', 'SKU'],
    b.items.map((i) => [i.name, 'Inventory', i.name, num(i.price), num(i.cost), num(qty.get(i.sku) ?? 0), i.sku]),
  );
  let tq = D(0);
  let tv = D(0);
  const ivRows: Array<Array<string | number | null>> = b.items
    .filter((i) => qty.has(i.sku))
    .map((i) => {
      const q = qty.get(i.sku)!;
      const v = q.times(i.cost);
      tq = tq.plus(q);
      tv = tv.plus(v);
      return [i.name, i.sku, num(q), num(v), num(i.cost)];
    });
  ivRows.push(['TOTAL', '', num(tq), num(tv), '']);
  const valuation = await qbReport(b, 'Inventory Valuation Summary', asOf, ['', 'SKU', 'Qty', 'Asset Value', 'Calc. Avg'], ivRows);

  // "Export data" (Settings → Tools → Export data): reports and lists in one
  // ZIP. The general ledger, journal, P&L and balance sheet are not needed.
  const zip = new AdmZip();
  zip.addFile('Trial_balance.xlsx', trialBalance);
  zip.addFile('Customers.xlsx', customers);
  zip.addFile('Vendors.xlsx', vendors);
  const gl: Array<Array<string | number | null>> = [];
  for (const d of b.invoices) gl.push(['', fmtDate.mdy(d.date), 'Invoice', d.number, partyName(b, d.party), '', 'Sales', num(d.original), null]);
  zip.addFile('General_ledger.xlsx', await qbReport(b, 'General Ledger', `July 1 - ${longDate(b.openingDate)}`, ['', 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Split', 'Amount', 'Balance'], gl));
  zip.addFile('Journal.xlsx', await qbReport(b, 'Journal', `July 1 - ${longDate(b.openingDate)}`, ['', 'Date', 'Transaction Type', 'Num', 'Name', 'Memo/Description', 'Account', 'Debit', 'Credit'], gl.map((r) => [...r.slice(0, 6), 'Accounts Receivable (A/R)', r[7], null])));
  zip.addFile('Profit_and_loss.xlsx', await qbReport(b, 'Profit and Loss', `July 1 - ${longDate(b.openingDate)}`, ['', 'Total'], [['Income'], ['Sales', 18450600], ['Total Income', 18450600]]));
  zip.addFile('Balance_sheet.xlsx', await qbReport(b, 'Balance Sheet', asOf, ['', 'Total'], [['ASSETS'], ['Cash in Hand', 185400]]));
  return {
    'QuickBooks Online - Export data.zip': zip.toBuffer(),
    'Account List.xlsx': accountList,
    'A_R Aging Detail.xlsx': ar,
    'A_P Aging Detail.xlsx': ap,
    'Product_Service List.xlsx': products,
    'Inventory Valuation Summary.xlsx': valuation,
  };
}

// ── QuickBooks Desktop ───────────────────────────────────────────────────
export async function quickbooksDesktop(b: SampleBooks): Promise<Record<string, Buffer | string>> {
  const tab = (cells: Array<string | number>) => cells.join('\t');
  const lines: string[] = [];
  lines.push(tab(['!HDR', 'PROD', 'VER', 'REL', 'IIFVER', 'DATE', 'TIME', 'ACCNTNT', 'ACCNTNTSPLITTIME']));
  lines.push(tab(['HDR', 'QuickBooks Pro', 'Version 34.0D', 'Release R7P', '1', '10/01/2026', '1790000000', 'N', '0']));
  lines.push(tab(['!ACCNT', 'NAME', 'REFNUM', 'TIMESTAMP', 'ACCNTTYPE', 'OBAMOUNT', 'DESC', 'ACCNUM', 'SCD', 'BANKNUM', 'EXTRA', 'HIDDEN']));
  b.accounts.forEach((a, i) => {
    const name = a.control === 'inventory' ? 'Inventory Asset' : a.name;
    lines.push(tab(['ACCNT', name, i + 1, 1790000000 + i, IIF_TYPE[a.kind], '0.00', '', a.number, '', '', a.control === 'inventory' ? 'INVENTORYASSET' : '', 'N']));
  });
  lines.push(tab(['ACCNT', 'Purchase Orders', 90, 1790000099, 'NONPOSTING', '0.00', '', '', '', '', '', 'N']));
  lines.push(tab(['!CUST', 'NAME', 'REFNUM', 'TIMESTAMP', 'BADDR1', 'BADDR2', 'BADDR3', 'PHONE1', 'EMAIL', 'TERMS', 'LIMIT', 'RESALENUM', 'HIDDEN']));
  b.customers.forEach((c, i) => lines.push(tab(['CUST', c.name, i + 1, 1790000100 + i, c.address, '', c.city, c.phone, c.email, c.terms, c.creditLimit, c.ntn, 'N'])));
  // A job: its invoices belong to its customer.
  const job = `${b.customers[0].name}:Gulberg Branch`;
  lines.push(tab(['CUST', job, 99, 1790000199, 'Main Boulevard', '', 'Lahore', '', '', 'Net 30', '0.00', '', 'N']));
  lines.push(tab(['!VEND', 'NAME', 'REFNUM', 'TIMESTAMP', 'PRINTAS', 'ADDR1', 'ADDR2', 'ADDR3', 'PHONE1', 'EMAIL', 'TERMS', 'TAXID', 'HIDDEN']));
  b.vendors.forEach((v, i) => lines.push(tab(['VEND', v.name, i + 1, 1790000200 + i, v.name, v.address, '', v.city, v.phone, v.email, v.terms, v.ntn, 'N'])));
  lines.push(tab(['!INVITEM', 'NAME', 'REFNUM', 'TIMESTAMP', 'INVITEMTYPE', 'DESC', 'PURCHASEDESC', 'ACCNT', 'ASSETACCNT', 'COGSACCNT', 'PRICE', 'COST', 'TAXABLE', 'REORDERPOINT', 'HIDDEN']));
  b.items.forEach((it, i) => lines.push(tab(['INVITEM', it.sku, i + 1, 1790000300 + i, 'INVENTORY', it.name, it.name, 'Sales', 'Inventory Asset', 'Cost of Goods Sold', it.price, it.cost, 'N', it.reorder, 'N'])));
  lines.push(tab(['INVITEM', 'Delivery Charge', 50, 1790000350, 'SERV', 'Delivery charge', '', 'Sales', '', '', '500.00', '0.00', 'N', '', 'N']));
  const iif = lines.join('\r\n') + '\r\n';

  // Trial balance as QuickBooks Desktop writes CSV: the date over the
  // columns in its own short form, numbered accounts "1000 · Cash in Hand".
  const label = (a: SampleAccount) => `${a.number} · ${a.control === 'inventory' ? 'Inventory Asset' : a.name}`;
  const tb = trialBalanceRows(b, label);
  const csvCell = (v: string | number | null) => (v === null ? '' : typeof v === 'number' ? `"${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}"` : `"${v.replace(/"/g, '""')}"`);
  const csv = [
    ['', 'Sep 30, 26'],
    ['', 'Debit', 'Credit'],
    ...tb.rows,
    ['TOTAL', num(tb.dr), num(tb.cr)],
  ]
    .map((r) => r.map(csvCell).join(','))
    .join('\r\n') + '\r\n';

  const asOf = `As of ${longDate(b.openingDate)}`;
  // One of the first customer's invoices is the job's.
  const invoices = b.invoices.map((d, i) => (i === 0 ? { ...d, job } : d));
  const ar = await qbReport(b, 'A/R Aging Detail', asOf, ['', 'Type', 'Date', 'Num', 'P. O. #', 'Name', 'Terms', 'Due Date', 'Class', 'Aging', 'Open Balance'], agingRows(b, invoices as never, 'Invoice', true), false);
  const ap = await qbReport(b, 'A/P Aging Detail', asOf, ['', 'Type', 'Date', 'Num', 'P. O. #', 'Name', 'Terms', 'Due Date', 'Class', 'Aging', 'Open Balance'], agingRows(b, b.bills, 'Bill', true), false);
  const qty = stockBySku(b);
  let tv = D(0);
  const ivRows: Array<Array<string | number | null>> = [['Inventory']];
  for (const i of b.items.filter((x) => qty.has(x.sku))) {
    const q = qty.get(i.sku)!;
    const v = q.times(i.cost);
    tv = tv.plus(v);
    ivRows.push([i.sku, i.name, num(q), num(i.cost), num(v), null, num(i.price), num(q.times(i.price)), null]);
  }
  ivRows.push(['Total Inventory', '', null, null, num(tv), null, null, null, null]);
  ivRows.push(['TOTAL', '', null, null, num(tv), null, null, null, null]);
  const valuation = await qbReport(b, 'Inventory Valuation Summary', asOf, ['', 'Item Description', 'On Hand', 'Avg Cost', 'Asset Value', '% of Tot Asset', 'Sales Price', 'Retail Value', '% of Tot Retail'], ivRows, false);
  return {
    'QuickBooks Lists.iif': iif,
    'Trial Balance.csv': csv,
    'A_R Aging Detail.xlsx': ar,
    'A_P Aging Detail.xlsx': ap,
    'Inventory Valuation Summary.xlsx': valuation,
  };
}
