/**
 * Writers for the formats FinMatrix reads today: the starter workbook, a
 * messy "as exported" generic workbook, TallyPrime XML, and Peachtree /
 * Sage 50 US report exports. Each writes the same SampleBooks.
 */
import Decimal from 'decimal.js';
import * as ExcelJS from 'exceljs';
import { buildStarterXlsx, BooksSpec } from '../../../test/fixtures/migration/workbook-builder';
import { fmtDate, money, SampleBooks } from '../books';

const D = (v: Decimal.Value) => new Decimal(v);
const dr = (v: string) => (D(v).greaterThan(0) ? money(v) : '');
const cr = (v: string) => (D(v).lessThan(0) ? money(D(v).negated()) : '');
const toBuffer = async (wb: ExcelJS.Workbook) => Buffer.from(await wb.xlsx.writeBuffer());

/** Stock per SKU, summed over locations (sheets without a location column). */
function stockBySku(b: SampleBooks) {
  const m = new Map<string, Decimal>();
  for (const s of b.stock) m.set(s.sku, (m.get(s.sku) ?? D(0)).plus(s.qty));
  return m;
}
const partyName = (b: SampleBooks, code: string) =>
  [...b.customers, ...b.vendors].find((p) => p.code === code)!.name;

// ── FinMatrix starter workbook ───────────────────────────────────────────
export function toBooksSpec(b: SampleBooks): BooksSpec {
  const qty = stockBySku(b);
  return {
    cutoverDate: b.cutoverDate,
    accounts: b.accounts.map((a) => ({ number: a.number, name: a.name, type: a.type, kind: a.kind })),
    customers: b.customers.map((c) => ({
      code: c.code,
      name: c.name,
      phone: c.phone,
      city: c.city,
      terms: c.terms,
      creditLimit: c.creditLimit,
      ntn: c.ntn,
    })),
    vendors: b.vendors.map((v) => ({ code: v.code, name: v.name, phone: v.phone, city: v.city, terms: v.terms })),
    items: b.items.map((i) => ({ sku: i.sku, name: i.name, category: i.category, unit: i.unit, cost: i.cost, price: i.price })),
    trialBalance: b.accounts
      .filter((a) => !D(b.balances.get(a.number) ?? 0).isZero())
      .map((a) => ({
        number: a.number,
        name: a.name,
        debit: dr(b.balances.get(a.number)!) || undefined,
        credit: cr(b.balances.get(a.number)!) || undefined,
      })),
    openInvoices: b.invoices.map((d) => ({ customer: d.party, number: d.number, date: d.date, due: d.due, original: d.original, amountDue: d.open })),
    openBills: b.bills.map((d) => ({ vendor: d.party, number: d.number, date: d.date, due: d.due, original: d.original, amountDue: d.open })),
    stock: b.items
      .filter((i) => qty.has(i.sku))
      .map((i) => ({ sku: i.sku, qty: qty.get(i.sku)!.toString(), cost: i.cost })),
  };
}

export const starterWorkbook = (b: SampleBooks) =>
  buildStarterXlsx(toBooksSpec(b), { keepInstructionRows: false });

// ── A generic workbook "as the accountant keeps it" ──────────────────────
export async function genericWorkbook(b: SampleBooks): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const chart = wb.addWorksheet('Chart');
  chart.addRow(['A/c Code', 'Account Title', 'Account Type']);
  for (const a of b.accounts) chart.addRow([a.number, a.name, a.type]);

  const tb = wb.addWorksheet('TB 30-09-2026');
  tb.addRow([`${b.company} — Trial Balance as on ${fmtDate.dmy(b.openingDate)}`]);
  tb.addRow([]);
  tb.addRow(['A/c Code', 'Ledger', 'Dr', 'Cr']);
  let tdr = D(0);
  let tcr = D(0);
  for (const a of b.accounts) {
    const v = b.balances.get(a.number) ?? '0';
    if (D(v).isZero()) continue;
    tb.addRow([a.number, a.name, dr(v), cr(v)]);
    if (D(v).greaterThan(0)) tdr = tdr.plus(v);
    else tcr = tcr.minus(v);
  }
  tb.addRow(['', 'TOTAL', money(tdr), money(tcr)]);

  const parties = wb.addWorksheet('Gahak List');
  parties.addRow(['Party Code', 'Naam', 'Mobile No', 'Shehar', 'Udhaar Limit']);
  for (const c of b.customers) parties.addRow([c.code, c.name, c.phone, c.city, c.creditLimit]);

  const sup = wb.addWorksheet('Suppliers');
  sup.addRow(['Supplier ID', 'Supplier Name', 'Contact']);
  for (const v of b.vendors) sup.addRow([v.code, v.name, v.phone]);

  const rec = wb.addWorksheet('Party Balances');
  rec.addRow(['Outstanding Receivables']);
  rec.addRow(['Party Name', 'Inv No', 'Inv Date', 'Due', 'Bill Amount', 'Balance Due']);
  for (const o of b.invoices)
    rec.addRow([partyName(b, o.party), o.number, fmtDate.dmy(o.date), fmtDate.dmy(o.due), `Rs ${o.original}`, `Rs ${o.open}`]);

  const pay = wb.addWorksheet('Creditors O-S');
  pay.addRow(['Creditor', 'Voucher No', 'Voucher Date', 'Total', 'Pending']);
  for (const o of b.bills) pay.addRow([partyName(b, o.party), o.number, fmtDate.dmy(o.date), o.original, o.open]);

  const items = wb.addWorksheet('Maal');
  items.addRow(['Item Code', 'Item Name', 'Group', 'UOM', 'Purchase Rate', 'Sale Rate']);
  for (const i of b.items) items.addRow([i.sku, i.name, i.category, i.unit, i.cost, i.price]);

  const stock = wb.addWorksheet('Closing Stock');
  stock.addRow(['Item Code', 'Closing Qty', 'Avg Cost']);
  const qty = stockBySku(b);
  for (const i of b.items) if (qty.has(i.sku)) stock.addRow([i.sku, qty.get(i.sku)!.toString(), i.cost]);

  wb.addWorksheet('Notes').addRow(['Prepared by the accountant. Figures as per ledger.']);
  return toBuffer(wb);
}

// ── TallyPrime XML (Data Interchange) ────────────────────────────────────
const x = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tallyAmt = (v: Decimal) => v.toFixed(2);

export function tallyFiles(b: SampleBooks): Record<string, string> {
  const head = (comment: string) => `<?xml version="1.0" encoding="UTF-8"?>\n<!-- ${comment} Invented sample data. -->\n`;
  const msg = (body: string) => `        <TALLYMESSAGE xmlns:UDF="TallyUDF">\n          ${body}\n        </TALLYMESSAGE>\n`;
  const groups = [
    ['Current Assets', ''],
    ['Current Liabilities', ''],
    ['Sundry Debtors', 'Current Assets'],
    ['Sundry Creditors', 'Current Liabilities'],
    ['Bank Accounts', 'Current Assets'],
    ['Cash-in-Hand', 'Current Assets'],
    ['Stock-in-Hand', 'Current Assets'],
    ['Loans & Advances (Asset)', 'Current Assets'],
    ['Fixed Assets', ''],
    ['Capital Account', ''],
    ['Loans (Liability)', ''],
    ['Secured Loans', 'Loans (Liability)'],
    ['Duties & Taxes', 'Current Liabilities'],
    ['Provisions', 'Current Liabilities'],
    ['Sales Accounts', ''],
    ['Direct Expenses', ''],
    ['Indirect Expenses', ''],
  ];
  let masters = '';
  for (const [g, parent] of groups) masters += msg(`<GROUP NAME="${x(g)}" RESERVEDNAME="${x(g)}"><PARENT>${x(parent)}</PARENT></GROUP>`);
  for (const a of b.accounts) {
    if (a.control === 'ar' || a.control === 'ap' || a.control === 'inventory') continue;
    if (a.control === 'retained') {
      masters += msg(`<LEDGER NAME="Profit &amp; Loss A/c" RESERVEDNAME="Profit &amp; Loss A/c"><PARENT></PARENT></LEDGER>`);
      continue;
    }
    masters += msg(`<LEDGER NAME="${x(a.name)}" RESERVEDNAME=""><PARENT>${x(a.tallyGroup)}</PARENT></LEDGER>`);
  }
  const days = (t: string) => `${t.replace(/\D/g, '') || '0'} Days`;
  for (const c of b.customers)
    masters += msg(
      `<LEDGER NAME="${x(c.name)}" RESERVEDNAME=""><PARENT>Sundry Debtors</PARENT><ADDRESS.LIST TYPE="String"><ADDRESS>${x(c.address)}</ADDRESS><ADDRESS>${x(c.city)}</ADDRESS></ADDRESS.LIST><LEDGERMOBILE>${c.phone}</LEDGERMOBILE><INCOMETAXNUMBER>${c.ntn}</INCOMETAXNUMBER><BILLCREDITPERIOD>${days(c.terms)}</BILLCREDITPERIOD><CREDITLIMIT>-${c.creditLimit}</CREDITLIMIT><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER>`,
    );
  for (const v of b.vendors)
    masters += msg(
      `<LEDGER NAME="${x(v.name)}" RESERVEDNAME=""><PARENT>Sundry Creditors</PARENT><LEDGERPHONE>${v.phone}</LEDGERPHONE><BILLCREDITPERIOD>${days(v.terms)}</BILLCREDITPERIOD><ISBILLWISEON>Yes</ISBILLWISEON></LEDGER>`,
    );
  const categories = [...new Set(b.items.map((i) => i.category))];
  for (const g of categories) masters += msg(`<STOCKGROUP NAME="${x(g)}"><PARENT></PARENT></STOCKGROUP>`);
  for (const i of b.items)
    masters += msg(
      `<STOCKITEM NAME="${x(i.name)}" RESERVEDNAME=""><PARENT>${x(i.category)}</PARENT><BASEUNITS>${x(i.unit)}</BASEUNITS><PARTNUMBER>${x(i.sku)}</PARTNUMBER><OPENINGRATE>${i.cost}/${x(i.unit)}</OPENINGRATE><STANDARDPRICELIST.LIST><DATE>20260701</DATE><RATE>${i.price}/${x(i.unit)}</RATE></STANDARDPRICELIST.LIST></STOCKITEM>`,
    );
  const mastersXml =
    head('TallyPrime "All Masters" export (Data Interchange XML).') +
    `<ENVELOPE>\n  <HEADER>\n    <TALLYREQUEST>Import Data</TALLYREQUEST>\n  </HEADER>\n  <BODY>\n    <IMPORTDATA>\n      <REQUESTDESC>\n        <REPORTNAME>All Masters</REPORTNAME>\n        <STATICVARIABLES><SVCURRENTCOMPANY>${x(b.company)}</SVCURRENTCOMPANY></STATICVARIABLES>\n      </REQUESTDESC>\n      <REQUESTDATA>\n${masters}      </REQUESTDATA>\n    </IMPORTDATA>\n  </BODY>\n</ENVELOPE>\n`;

  // Trial balance, ledger-wise: debits negative as Tally writes them; the
  // Sundry Debtors / Creditors group lines are subtotals.
  const line = (name: string, v: Decimal) =>
    `  <DSPACCNAME><DSPDISPNAME>${x(name)}</DSPDISPNAME></DSPACCNAME>\n  <DSPACCINFO><DSPCLDRAMT><DSPCLDRAMTA>${v.greaterThan(0) ? tallyAmt(v.negated()) : ''}</DSPCLDRAMTA></DSPCLDRAMT><DSPCLCRAMT><DSPCLCRAMTA>${v.lessThan(0) ? tallyAmt(v.negated()) : ''}</DSPCLCRAMTA></DSPCLCRAMT></DSPACCINFO>\n`;
  const open = (docs: SampleBooks['invoices'], code: string) =>
    docs.filter((d) => d.party === code).reduce((t, d) => t.plus(d.open), D(0));
  let tb = '';
  for (const a of b.accounts) {
    const v = D(b.balances.get(a.number) ?? 0);
    if (a.control === 'ar') {
      tb += line('Sundry Debtors', v);
      for (const c of b.customers) {
        const o = open(b.invoices, c.code);
        if (!o.isZero()) tb += line(c.name, o);
      }
    } else if (a.control === 'ap') {
      tb += line('Sundry Creditors', v);
      for (const p of b.vendors) {
        const o = open(b.bills, p.code);
        if (!o.isZero()) tb += line(p.name, o.negated());
      }
    } else if (a.control === 'inventory') {
      tb += line('Closing Stock', v);
    } else if (a.control === 'retained') {
      tb += line('Profit & Loss A/c', v);
    } else if (!v.isZero()) {
      tb += line(a.name, v);
    }
  }
  const tbXml = head(`TallyPrime Trial Balance, ledger-wise, closing balances as on ${fmtDate.dMonY(b.openingDate)}.`) + `<ENVELOPE>\n${tb}</ENVELOPE>\n`;

  const bills = (docs: SampleBooks['invoices'], receivable: boolean) =>
    docs
      .map((d) => {
        const overdue = Math.max(0, Math.round((Date.parse(b.openingDate) - Date.parse(d.due)) / 86400000));
        const amount = D(d.open);
        return `  <BILLFIXED><BILLDATE>${fmtDate.dMonY(d.date)}</BILLDATE><BILLREF>${x(d.number)}</BILLREF><BILLPARTY>${x(partyName(b, d.party))}</BILLPARTY></BILLFIXED>\n  <BILLCL>${tallyAmt(receivable ? amount.negated() : amount)}</BILLCL><BILLDUE>${fmtDate.dMonY(d.due)}</BILLDUE><BILLOVERDUE>${overdue}</BILLOVERDUE>\n`;
      })
      .join('');
  const recXml = head(`TallyPrime Bills Receivable (bill-wise outstanding) as on ${fmtDate.dMonY(b.openingDate)}.`) + `<ENVELOPE>\n${bills(b.invoices, true)}</ENVELOPE>\n`;
  const payXml = head(`TallyPrime Bills Payable (bill-wise outstanding) as on ${fmtDate.dMonY(b.openingDate)}.`) + `<ENVELOPE>\n${bills(b.bills, false)}</ENVELOPE>\n`;

  const qty = stockBySku(b);
  let stock = '';
  for (const g of categories) {
    const its = b.items.filter((i) => i.category === g && qty.has(i.sku));
    const gq = its.reduce((t, i) => t.plus(qty.get(i.sku)!), D(0));
    const gv = its.reduce((t, i) => t.plus(qty.get(i.sku)!.times(i.cost)), D(0));
    stock += `  <DSPACCNAME><DSPDISPNAME>${x(g)}</DSPDISPNAME></DSPACCNAME>\n  <DSPSTKINFO><DSPSTKCL><DSPCLQTY></DSPCLQTY><DSPCLRATE></DSPCLRATE><DSPCLAMTA>${tallyAmt(gv.negated())}</DSPCLAMTA></DSPSTKCL></DSPSTKINFO>\n`;
    void gq;
    for (const i of its) {
      const q = qty.get(i.sku)!;
      stock += `  <DSPACCNAME><DSPDISPNAME>${x(i.name)}</DSPDISPNAME></DSPACCNAME>\n  <DSPSTKINFO><DSPSTKCL><DSPCLQTY>${q.toString()} ${x(i.unit)}</DSPCLQTY><DSPCLRATE>${i.cost}/${x(i.unit)}</DSPCLRATE><DSPCLAMTA>${tallyAmt(q.times(i.cost).negated())}</DSPCLAMTA></DSPSTKCL></DSPSTKINFO>\n`;
    }
  }
  const stockXml = head(`TallyPrime Stock Summary, closing balance as on ${fmtDate.dMonY(b.openingDate)}.`) + `<ENVELOPE>\n${stock}</ENVELOPE>\n`;
  return {
    'tally-masters.xml': mastersXml,
    'tally-trial-balance.xml': tbXml,
    'tally-bills-receivable.xml': recXml,
    'tally-bills-payable.xml': payXml,
    'tally-stock-summary.xml': stockXml,
  };
}

// ── Peachtree / Sage 50 US report exports ────────────────────────────────
async function peachtreeReport(
  b: SampleBooks,
  title: string,
  header: string[],
  rows: Array<Array<string | number | null>>,
  asOf = true,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(title.slice(0, 31));
  ws.addRow([b.company]);
  ws.addRow([title]);
  if (asOf) ws.addRow([`As of ${fmtDate.monDY(b.openingDate)}`]);
  ws.addRow(['Filter Criteria includes: Report order is by ID. Report is printed in Detail Format.']);
  ws.addRow(header);
  for (const r of rows) ws.addRow(r);
  return toBuffer(wb);
}
const num = (v: Decimal.Value) => Number(money(v));

export async function peachtreeReports(b: SampleBooks): Promise<Record<string, Buffer>> {
  const out: Record<string, Buffer> = {};
  const tb: Array<Array<string | number | null>> = [];
  let tdr = D(0);
  let tcr = D(0);
  for (const a of b.accounts) {
    const v = D(b.balances.get(a.number) ?? 0);
    if (v.isZero()) continue;
    tb.push([a.number, a.name, v.greaterThan(0) ? num(v) : null, v.lessThan(0) ? num(v.negated()) : null]);
    if (v.greaterThan(0)) tdr = tdr.plus(v);
    else tcr = tcr.minus(v);
  }
  tb.push(['', 'Total:', num(tdr), num(tcr)]);
  out['General Ledger Trial Balance.xlsx'] = await peachtreeReport(b, 'General Ledger Trial Balance', ['Account ID', 'Account Description', 'Debit Amt', 'Credit Amt'], tb);

  const aged = (parties: SampleBooks['customers'], docs: SampleBooks['invoices'], idHead: string, nameHead: string) => {
    const rows: Array<Array<string | number | null>> = [];
    const total = [D(0), D(0), D(0), D(0), D(0)];
    const bucket = (d: SampleBooks['invoices'][number]) => {
      const age = Math.round((Date.parse(b.openingDate) - Date.parse(d.date)) / 86400000);
      return age <= 30 ? 0 : age <= 60 ? 1 : age <= 90 ? 2 : 3;
    };
    for (const p of parties) {
      const mine = docs.filter((d) => d.party === p.code);
      if (!mine.length) continue;
      rows.push([p.code, p.name, null, null, null, null, null, null, null]);
      const sub = [D(0), D(0), D(0), D(0), D(0)];
      for (const d of mine) {
        const cells: Array<number | null> = [null, null, null, null];
        cells[bucket(d)] = num(d.open);
        sub[bucket(d)] = sub[bucket(d)].plus(d.open);
        sub[4] = sub[4].plus(d.open);
        rows.push([null, null, d.number, fmtDate.mdy(d.date), ...cells, num(d.open)]);
      }
      rows.push([null, `${p.code} Total`, null, null, ...sub.map((s) => (s.isZero() ? null : num(s)))]);
      sub.forEach((s, i) => (total[i] = total[i].plus(s)));
    }
    rows.push([null, 'Report Total', null, null, ...total.map((s) => num(s))]);
    return { header: [idHead, nameHead, 'Invoice/CM #', 'Date', '0 - 30', '31 - 60', '61 - 90', 'Over 90 days', 'Amount Due'], rows };
  };
  const ar = aged(b.customers, b.invoices, 'Customer ID', 'Customer');
  out['Aged Receivables.xlsx'] = await peachtreeReport(b, 'Aged Receivables', ar.header, ar.rows);
  const ap = aged(b.vendors, b.bills, 'Vendor ID', 'Vendor');
  out['Aged Payables.xlsx'] = await peachtreeReport(b, 'Aged Payables', ap.header, ap.rows);

  const qty = stockBySku(b);
  const totalValue = b.items.reduce((t, i) => t.plus((qty.get(i.sku) ?? D(0)).times(i.cost)), D(0));
  const iv: Array<Array<string | number | null>> = b.items
    .filter((i) => qty.has(i.sku))
    .map((i) => {
      const value = qty.get(i.sku)!.times(i.cost);
      return [i.sku, i.name, i.unit, 'Average', num(qty.get(i.sku)!), num(value), num(i.cost), Number(value.dividedBy(totalValue).times(100).toFixed(2))];
    });
  iv.push(['', 'Report Total', '', '', null, num(totalValue), null, 100]);
  out['Inventory Valuation Report.xlsx'] = await peachtreeReport(b, 'Inventory Valuation Report', ['Item ID', 'Item Description', 'Stocking U/M', 'Cost Method', 'Qty on Hand', 'Item Value', 'Avg Cost', '% of Inv Value'], iv);

  // Lists, for the reports-only route (any Peachtree / Sage 50 US version).
  const typeName: Record<string, string> = {
    Cash: 'Cash',
    Bank: 'Cash',
    'Accounts Receivable': 'Accounts Receivable',
    Inventory: 'Inventory',
    Prepaid: 'Other Current Assets',
    'Fixed Asset': 'Fixed Assets',
    'Accounts Payable': 'Accounts Payable',
    'Tax Payable': 'Other Current Liabilities',
    'Other Liability': 'Other Current Liabilities',
    'Notes Payable': 'Long Term Liabilities',
    'Owner Equity': 'Equity-doesn\'t close',
    'Retained Earnings': 'Equity-Retained Earnings',
    Sales: 'Income',
    'Cost of Goods': 'Cost of Sales',
    Payroll: 'Expenses',
    Operating: 'Expenses',
    Depreciation: 'Expenses',
    'Other Expense': 'Expenses',
  };
  out['Chart of Accounts.xlsx'] = await peachtreeReport(
    b,
    'Chart of Accounts',
    ['Account ID', 'Account Description', 'Active?', 'Account Type'],
    b.accounts.map((a) => [a.number, a.name, 'Yes', a.kind === 'Fixed Asset' && a.number === '1590' ? 'Accumulated Depreciation' : typeName[a.kind] ?? 'Expenses']),
    false,
  );
  out['Customer List.xlsx'] = await peachtreeReport(
    b,
    'Customer List',
    ['Customer ID', 'Customer Name', 'Contact', 'Telephone 1', 'Bill to City', 'Terms', 'Credit Limit', 'Resale No'],
    b.customers.map((c) => [c.code, c.name, '', c.phone, c.city, c.terms, num(c.creditLimit), c.ntn]),
    false,
  );
  out['Vendor List.xlsx'] = await peachtreeReport(
    b,
    'Vendor List',
    ['Vendor ID', 'Vendor Name', 'Contact', 'Telephone 1', 'City', 'Terms', 'Tax ID'],
    b.vendors.map((v) => [v.code, v.name, '', v.phone, v.city, v.terms, v.ntn]),
    false,
  );
  out['Item List.xlsx'] = await peachtreeReport(
    b,
    'Item List',
    ['Item ID', 'Item Description', 'Item Class', 'Active?', 'Item Type', 'Stocking U/M', 'Sales Price 1', 'Last Unit Cost', 'Qty on Hand'],
    b.items.map((i) => [i.sku, i.name, 'Stock item', 'Yes', i.category, i.unit, num(i.price), num(i.cost), num(qty.get(i.sku) ?? 0)]),
    false,
  );
  return out;
}
