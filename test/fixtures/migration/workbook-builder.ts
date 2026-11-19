/**
 * Builds starter workbooks (and messier look-alikes) for the Migration Center
 * golden fixtures and the property test. Pure: no database, no API.
 *
 * A `BooksSpec` is a small company as at a cutover date — chart, parties,
 * items, trial balance and the open items and stock behind its control
 * accounts. `consistentBooks()` makes one whose detail ties to the controls
 * exactly; the faulty fixtures start from it and break one thing.
 */
import * as ExcelJS from 'exceljs';

export interface BooksSpec {
  cutoverDate: string;
  accounts: Array<{
    number: string;
    name: string;
    type: string;
    kind?: string;
    parent?: string;
  }>;
  customers: Array<{
    code?: string;
    name: string;
    phone?: string;
    city?: string;
    terms?: string;
    creditLimit?: string;
    ntn?: string;
  }>;
  vendors: Array<{
    code?: string;
    name: string;
    phone?: string;
    city?: string;
    terms?: string;
  }>;
  items: Array<{
    sku: string;
    name: string;
    category?: string;
    unit?: string;
    cost: string;
    price: string;
  }>;
  trialBalance: Array<{
    number: string;
    name: string;
    debit?: string;
    credit?: string;
  }>;
  openInvoices: Array<{
    customer: string;
    number: string;
    date: string;
    due?: string;
    original: string;
    amountDue: string;
  }>;
  openBills: Array<{
    vendor: string;
    number: string;
    date: string;
    due?: string;
    original: string;
    amountDue: string;
  }>;
  stock: Array<{ sku: string; qty: string; cost: string }>;
}

const SHEETS: Array<{ name: string; headers: string[] }> = [
  {
    name: 'Accounts',
    headers: [
      'Account number',
      'Account name',
      'Type',
      'Kind',
      'Parent number',
    ],
  },
  {
    name: 'Customers',
    headers: [
      'Customer code',
      'Name',
      'Phone',
      'Email',
      'Address',
      'City',
      'Payment terms',
      'Credit limit',
      'NTN',
    ],
  },
  {
    name: 'Vendors',
    headers: [
      'Vendor code',
      'Name',
      'Phone',
      'Email',
      'Address',
      'City',
      'Payment terms',
      'NTN',
    ],
  },
  {
    name: 'Items',
    headers: [
      'SKU',
      'Name',
      'Category',
      'Unit',
      'Unit cost',
      'Selling price',
      'Reorder point',
    ],
  },
  {
    name: 'Trial Balance',
    headers: ['Account number', 'Account name', 'Debit', 'Credit'],
  },
  {
    name: 'Open Invoices',
    headers: [
      'Customer code or name',
      'Invoice number',
      'Invoice date',
      'Due date',
      'Original amount',
      'Amount due',
    ],
  },
  {
    name: 'Open Bills',
    headers: [
      'Vendor code or name',
      'Bill number',
      'Bill date',
      'Due date',
      'Original amount',
      'Amount due',
    ],
  },
  { name: 'Stock', headers: ['SKU', 'Quantity on hand', 'Unit cost'] },
];

/** Starter-workbook rows for each sheet, in header order. */
export function rowsFor(
  spec: BooksSpec,
): Record<string, Array<Array<string | number | null>>> {
  return {
    Accounts: spec.accounts.map((a) => [
      a.number,
      a.name,
      a.type,
      a.kind ?? null,
      a.parent ?? null,
    ]),
    Customers: spec.customers.map((c) => [
      c.code ?? null,
      c.name,
      c.phone ?? null,
      null,
      null,
      c.city ?? null,
      c.terms ?? null,
      c.creditLimit ?? null,
      c.ntn ?? null,
    ]),
    Vendors: spec.vendors.map((v) => [
      v.code ?? null,
      v.name,
      v.phone ?? null,
      null,
      null,
      v.city ?? null,
      v.terms ?? null,
      null,
    ]),
    Items: spec.items.map((i) => [
      i.sku,
      i.name,
      i.category ?? null,
      i.unit ?? null,
      i.cost,
      i.price,
      null,
    ]),
    'Trial Balance': spec.trialBalance.map((t) => [
      t.number,
      t.name,
      t.debit ?? null,
      t.credit ?? null,
    ]),
    'Open Invoices': spec.openInvoices.map((o) => [
      o.customer,
      o.number,
      o.date,
      o.due ?? null,
      o.original,
      o.amountDue,
    ]),
    'Open Bills': spec.openBills.map((o) => [
      o.vendor,
      o.number,
      o.date,
      o.due ?? null,
      o.original,
      o.amountDue,
    ]),
    Stock: spec.stock.map((s) => [s.sku, s.qty, s.cost]),
  };
}

/** A starter workbook, with its instruction and example rows left in place as an owner would. */
export async function buildStarterXlsx(
  spec: BooksSpec,
  opts: { keepInstructionRows?: boolean } = {},
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const rows = rowsFor(spec);
  for (const sheet of SHEETS) {
    const data = rows[sheet.name];
    if (sheet.name === 'Stock' && data.length === 0 && spec.items.length === 0)
      continue;
    const ws = wb.addWorksheet(sheet.name);
    ws.addRow(sheet.headers);
    if (opts.keepInstructionRows !== false) {
      ws.addRow(
        sheet.headers.map((h, i) => (i === 0 ? `HOW TO FILL: ${h}` : h)),
      );
      ws.addRow(sheet.headers.map((h, i) => (i === 0 ? `طریقہ: ${h}` : h)));
      ws.addRow(
        sheet.headers.map((_, i) => (i === 0 ? 'EXAMPLE 1000' : 'example')),
      );
    }
    for (const r of data) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Exact decimal arithmetic on short strings, so a fixture's own totals are never floats. */
export function sum(values: string[]): string {
  let cents = BigInt(0);
  for (const v of values) cents += toCents(v);
  return fromCents(cents);
}
export function toCents(v: string): bigint {
  const clean = v.replace(/[^0-9.-]/g, '');
  const neg = clean.startsWith('-');
  const [w, f = ''] = clean.replace('-', '').split('.');
  return (
    (neg ? -1n : 1n) *
    (BigInt(w || '0') * 100n + BigInt((f + '00').slice(0, 2)))
  );
}
export function fromCents(c: bigint): string {
  const neg = c < 0n;
  const a = neg ? -c : c;
  return `${neg ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`;
}
/** qty × cost in cents: (q·100)(c·100)/100 = q·c·100. Quantities here are whole units. */
export function mul(qty: string, cost: string): string {
  return fromCents((toCents(qty) * toCents(cost)) / 100n);
}

/**
 * Fixture (a): a small furniture distributor as at 30 June 2026. Every
 * control ties: AR 245,000 = open invoices; AP 163,250 = open bills;
 * Inventory 182,000 = stock; debits = credits = 1,092,500.50.
 */
export function cleanBooks(): BooksSpec {
  return {
    cutoverDate: '2026-06-30',
    accounts: [
      { number: '1000', name: 'Cash', type: 'Asset', kind: 'Cash' },
      {
        number: '1100',
        name: 'Accounts Receivable',
        type: 'Asset',
        kind: 'Accounts Receivable',
      },
      { number: '1200', name: 'Inventory', type: 'Asset', kind: 'Inventory' },
      {
        number: '1500',
        name: 'Furniture & Fixtures',
        type: 'Asset',
        kind: 'Fixed Asset',
      },
      {
        number: '2000',
        name: 'Accounts Payable',
        type: 'Liability',
        kind: 'Accounts Payable',
      },
      {
        number: '2100',
        name: 'Short-term Loan',
        type: 'Liability',
        kind: 'Notes Payable',
      },
      {
        number: '3000',
        name: 'Owner Equity',
        type: 'Equity',
        kind: 'Owner Equity',
      },
      {
        number: '3100',
        name: 'Retained Earnings',
        type: 'Equity',
        kind: 'Retained Earnings',
      },
    ],
    customers: [
      {
        code: 'C-0001',
        name: 'Al-Noor Traders',
        phone: '0300-1234567',
        city: 'Lahore',
        terms: 'Net 30',
        creditLimit: '5,00,000',
        ntn: '1234567-8',
      },
      {
        code: 'C-0002',
        name: 'Bismillah Store',
        phone: '0321-7654321',
        city: 'Lahore',
        terms: '15 days',
      },
      {
        code: 'C-0003',
        name: 'Raza & Sons',
        city: 'Faisalabad',
        terms: 'Net 30',
      },
      { code: 'C-0004', name: 'گلشن کریانہ', city: 'ملتان', terms: 'نقد' },
    ],
    vendors: [
      {
        code: 'V-0001',
        name: 'Karachi Packaging',
        phone: '021-34567890',
        city: 'Karachi',
        terms: 'Net 45',
      },
      { code: 'V-0002', name: 'Lahore Mills', city: 'Lahore', terms: 'Net 30' },
    ],
    items: [
      {
        sku: 'CHR-001',
        name: 'Dining chair — walnut',
        category: 'Chairs',
        unit: 'pcs',
        cost: '8500',
        price: '12,500',
      },
      {
        sku: 'TBL-001',
        name: 'Dining table — walnut',
        category: 'Tables',
        unit: 'pcs',
        cost: '25000',
        price: '38000',
      },
      {
        sku: 'CUS-001',
        name: 'Seat cushion',
        category: 'Accessories',
        unit: 'pcs',
        cost: '1250',
        price: '2000',
      },
    ],
    trialBalance: [
      { number: '1000', name: 'Cash', debit: '1,50,000' },
      { number: '1010', name: 'Business Checking', debit: 'Rs 4,20,500.50' },
      { number: '1100', name: 'Accounts Receivable', debit: '245000' },
      { number: '1200', name: 'Inventory', debit: '1,82,000' },
      { number: '1500', name: 'Furniture & Fixtures', debit: '95,000' },
      { number: '2000', name: 'Accounts Payable', credit: '1,63,250' },
      { number: '2100', name: 'Short-term Loan', credit: '2,00,000' },
      { number: '3000', name: 'Owner Equity', credit: '5,00,000' },
      { number: '3100', name: 'Retained Earnings', credit: '2,29,250.50' },
    ],
    openInvoices: [
      {
        customer: 'C-0001',
        number: 'INV-1001',
        date: '15/04/2026',
        due: '15/05/2026',
        original: '1,20,000',
        amountDue: '1,20,000',
      },
      {
        customer: 'Al-Noor Traders',
        number: 'INV-1002',
        date: '20/05/2026',
        due: '19/06/2026',
        original: '80,000',
        amountDue: '45,000',
      },
      {
        customer: 'C-0002',
        number: 'INV-1003',
        date: '28/05/2026',
        due: '12/06/2026',
        original: '50,000',
        amountDue: '50,000',
      },
      {
        customer: 'گلشن کریانہ',
        number: 'INV-1004',
        date: '13/06/2026',
        original: '30,000',
        amountDue: '30,000',
      },
    ],
    openBills: [
      {
        vendor: 'V-0001',
        number: 'KP-7781',
        date: '14/05/2026',
        due: '28/06/2026',
        original: '1,00,000',
        amountDue: '1,00,000',
      },
      {
        vendor: 'Karachi Packaging',
        number: 'KP-7790',
        date: '21/06/2026',
        original: '50,000',
        amountDue: '23,250',
      },
      {
        vendor: 'V-0002',
        number: 'LM-301',
        date: '25/06/2026',
        original: '40,000',
        amountDue: '40,000',
      },
    ],
    stock: [
      { sku: 'CHR-001', qty: '12', cost: '8500' },
      { sku: 'TBL-001', qty: '2', cost: '25,000' },
      { sku: 'CUS-001', qty: '24', cost: '1,250' },
    ],
  };
}

/** Fixture (b): the trial balance is fifty paisa short on the credit side. */
/**
 * (g) The clean books with every amount form a Pakistani ledger uses — Urdu
 * digits, PKR and Rs prefixes, a /- suffix, a trailing decimal, month-name
 * dates — plus one cell, INV-1001's amount due, typed as "12,0000". The
 * first reader strips the commas and reads 120,000 (the right figure, as it
 * happens); the second reader refuses the shape, so the owner is asked.
 */
export function amountFormsBooks(): BooksSpec {
  const b = cleanBooks();
  const tb = (n: string) => b.trialBalance.find((t) => t.number === n)!;
  tb('1000').debit = '۱۵۰۰۰۰';
  tb('1100').debit = 'PKR 245,000';
  tb('1200').debit = '182000.00';
  tb('1500').debit = '95,000/-';
  tb('3000').credit = '500,000';
  b.openInvoices[0].amountDue = '12,0000';
  b.openInvoices[0].date = '15 Apr 2026';
  b.stock[0].cost = 'Rs 8,500';
  return b;
}

export function unbalancedBooks(): BooksSpec {
  const b = cleanBooks();
  b.trialBalance = b.trialBalance.map((t) =>
    t.number === '3100' ? { ...t, credit: '2,29,250.00' } : t,
  );
  return b;
}

/** Fixture (c): open invoices total 1,000 less than the receivables control. */
export function arMismatchBooks(): BooksSpec {
  const b = cleanBooks();
  b.openInvoices = b.openInvoices.map((o) =>
    o.number === 'INV-1004' ? { ...o, amountDue: '29,000' } : o,
  );
  return b;
}

/** Fixture (d): four cushions short — stock is worth 5,000 less than the inventory line. */
export function stockMismatchBooks(): BooksSpec {
  const b = cleanBooks();
  b.stock = b.stock.map((s) => (s.sku === 'CUS-001' ? { ...s, qty: '20' } : s));
  return b;
}

/**
 * Fixture (e): a customer listed twice, an invoice row typed twice, and
 * dates that read both ways (every day and month ≤ 12). Once the owner
 * merges the customer, skips the repeated invoice and says day/month, it is
 * fixture (a) again and passes every check.
 */
export function duplicatesAndAmbiguousBooks(): BooksSpec {
  const b = cleanBooks();
  b.customers = [
    ...b.customers,
    { code: 'C-0001', name: 'Al Noor Traders', city: 'Lahore' },
  ];
  const dates: Record<string, [string, string]> = {
    'INV-1001': ['04/04/2026', '04/05/2026'],
    'INV-1002': ['05/05/2026', '06/06/2026'],
    'INV-1003': ['06/05/2026', '06/06/2026'],
    'INV-1004': ['12/06/2026', '12/06/2026'],
  };
  b.openInvoices = b.openInvoices.map((o) => ({
    ...o,
    date: dates[o.number][0],
    due: dates[o.number][1],
  }));
  b.openInvoices.push({ ...b.openInvoices[2] });
  return b;
}

/**
 * Fixture (f): what an owner exports from an old system and never tidies — a
 * generic spreadsheet whose sheets and headers are named in its own words
 * (Roman Urdu, abbreviations, title rows above the header), amounts in lakh
 * grouping with "Rs", a Dr/Cr column, and no Accounts sheet. Same books as (a).
 */
export async function buildMessyGenericXlsx(): Promise<Buffer> {
  const b = cleanBooks();
  const wb = new ExcelJS.Workbook();

  const tb = wb.addWorksheet('TB June 2026');
  tb.addRow(['Al-Noor Furniture — Trial Balance as on 30-06-2026']);
  tb.addRow([]);
  tb.addRow(['A/c Code', 'Ledger', 'Dr', 'Cr']);
  for (const t of b.trialBalance)
    tb.addRow([t.number, t.name, t.debit ?? '', t.credit ?? '']);
  tb.addRow(['', 'TOTAL', '10,92,500.50', '10,92,500.50']);

  const parties = wb.addWorksheet('Gahak List');
  parties.addRow(['Party Code', 'Naam', 'Mobile No', 'Shehar', 'Udhaar Limit']);
  for (const c of b.customers)
    parties.addRow([
      c.code ?? '',
      c.name,
      c.phone ?? '',
      c.city ?? '',
      c.creditLimit ?? '',
    ]);

  const sup = wb.addWorksheet('Suppliers');
  sup.addRow(['Supplier ID', 'Supplier Name', 'Contact']);
  for (const v of b.vendors) sup.addRow([v.code ?? '', v.name, v.phone ?? '']);

  const rec = wb.addWorksheet('Party Balances');
  rec.addRow(['Outstanding Receivables']);
  rec.addRow([
    'Party Name',
    'Inv No',
    'Inv Date',
    'Due',
    'Bill Amount',
    'Balance Due',
  ]);
  for (const o of b.openInvoices)
    rec.addRow([
      o.customer,
      o.number,
      o.date,
      o.due ?? '',
      `Rs ${o.original}`,
      `Rs ${o.amountDue}`,
    ]);

  const pay = wb.addWorksheet('Creditors O-S');
  pay.addRow(['Creditor', 'Voucher No', 'Voucher Date', 'Total', 'Pending']);
  for (const o of b.openBills)
    pay.addRow([o.vendor, o.number, o.date, o.original, o.amountDue]);

  const items = wb.addWorksheet('Maal');
  items.addRow([
    'Item Code',
    'Item Name',
    'Group',
    'UOM',
    'Purchase Rate',
    'Sale Rate',
  ]);
  for (const i of b.items)
    items.addRow([
      i.sku,
      i.name,
      i.category ?? '',
      i.unit ?? '',
      i.cost,
      i.price,
    ]);

  const stock = wb.addWorksheet('Closing Stock');
  stock.addRow(['Item Code', 'Closing Qty', 'Avg Cost']);
  for (const s of b.stock) stock.addRow([s.sku, s.qty, s.cost]);

  wb.addWorksheet('Notes').addRow([
    'Prepared by the accountant. Figures as per ledger.',
  ]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** A deterministic PRNG, so a failing property case can be replayed by its seed. */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/**
 * A random but VALID small company: balanced trial balance, open invoices
 * that sum to AR, open bills that sum to AP, stock that sums to inventory.
 * Amounts are whole rupees or paisa, formatted randomly (lakh grouping, Rs,
 * plain), dates are dd/mm/yyyy with at least one day > 12 per column.
 */
export function randomBooks(
  seed: number,
  cutoverDate = '2026-06-30',
): BooksSpec {
  const r = rng(seed);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const money = () =>
    `${int(1, 400) * 250}${r() < 0.3 ? `.${String(int(0, 99)).padStart(2, '0')}` : ''}`;
  const fmt = (v: string) => {
    const [w, f] = v.split('.');
    const lakh =
      w.length > 3
        ? w.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',') +
          ',' +
          w.slice(-3)
        : w;
    const intl = w.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const pick = int(0, 5);
    const body =
      (pick === 0 ? w : pick === 1 ? lakh : intl) + (f ? `.${f}` : '');
    if (pick === 3) return `Rs ${body}`;
    if (pick === 4) return `${body}/-`;
    if (pick === 5)
      return body.replace(/\d/g, (ch) =>
        String.fromCharCode(0x6f0 + Number(ch)),
      );
    return body;
  };
  const date = (forceDayOver12: boolean) => {
    const m = int(1, 6);
    const d = forceDayOver12 ? int(13, 28) : int(1, 28);
    return `${String(d).padStart(2, '0')}/${String(m).padStart(2, '0')}/2026`;
  };
  const nCust = int(1, 8);
  const nVend = int(1, 6);
  const nItems = int(0, 6);
  const customers = Array.from({ length: nCust }, (_, i) => ({
    code: `C-${String(i + 1).padStart(4, '0')}`,
    name: `Customer ${seed}-${i + 1}`,
  }));
  const vendors = Array.from({ length: nVend }, (_, i) => ({
    code: `V-${String(i + 1).padStart(4, '0')}`,
    name: `Vendor ${seed}-${i + 1}`,
  }));
  const items = Array.from({ length: nItems }, (_, i) => ({
    sku: `SKU-${seed}-${i + 1}`,
    name: `Item ${i + 1}`,
    cost: String(int(1, 200) * 25),
    price: String(int(201, 400) * 25),
  }));
  const openInvoices = Array.from({ length: int(0, 10) }, (_, i) => {
    const due = money();
    const extra = r() < 0.4 ? String(int(1, 50) * 100) : '0';
    return {
      customer:
        r() < 0.5
          ? customers[int(0, nCust - 1)].code!
          : customers[int(0, nCust - 1)].name,
      number: `INV-${seed}-${i + 1}`,
      date: date(i === 0),
      original: fmt(sum([due, extra])),
      amountDue: fmt(due),
      _due: due,
    };
  });
  const openBills = Array.from({ length: int(0, 8) }, (_, i) => {
    const due = money();
    return {
      vendor: vendors[int(0, nVend - 1)].code!,
      number: `B-${seed}-${i + 1}`,
      date: date(i === 0),
      original: fmt(due),
      amountDue: fmt(due),
      _due: due,
    };
  });
  const stock = items
    .filter(() => r() < 0.8)
    .map((it) => ({ sku: it.sku, qty: String(int(1, 60)), cost: it.cost }));
  const ar = sum(openInvoices.map((o) => o._due));
  const ap = sum(openBills.map((o) => o._due));
  const inv = sum(stock.map((s) => mul(s.qty, s.cost)));
  const cash = money();
  const bank = money();
  const loan = money();
  const debit = sum([cash, bank, ar, inv]);
  const credit = sum([ap, loan]);
  const equity = sum([debit, `-${credit}`]);
  const tb: BooksSpec['trialBalance'] = [
    { number: '1000', name: 'Cash', debit: fmt(cash) },
    { number: '1010', name: 'Business Checking', debit: fmt(bank) },
    ...(toCents(ar) !== 0n
      ? [{ number: '1100', name: 'Accounts Receivable', debit: fmt(ar) }]
      : []),
    ...(toCents(inv) !== 0n
      ? [{ number: '1200', name: 'Inventory', debit: fmt(inv) }]
      : []),
    ...(toCents(ap) !== 0n
      ? [{ number: '2000', name: 'Accounts Payable', credit: fmt(ap) }]
      : []),
    { number: '2100', name: 'Loan', credit: fmt(loan) },
    toCents(equity) >= 0n
      ? { number: '3000', name: 'Owner Equity', credit: fmt(equity) }
      : {
          number: '3000',
          name: 'Owner Equity',
          debit: fmt(equity.replace('-', '')),
        },
  ];
  return {
    cutoverDate,
    accounts: [
      {
        number: '2100',
        name: 'Loan',
        type: 'Liability',
        kind: 'Notes Payable',
      },
    ],
    customers,
    vendors,
    items,
    trialBalance: tb,
    openInvoices: openInvoices.map(({ _due, ...o }) => o),
    openBills: openBills.map(({ _due, ...o }) => o),
    stock,
  };
}
