/**
 * The invented company every Migration Center sample is made from: one set of
 * books, written out in every source's export format, so every format must
 * give the same result in FinMatrix. No real business data.
 *
 * Indus Valley Distributors (Pvt) Ltd — a Lahore grocery distributor with a
 * second godown in Karachi. Fiscal year starts in July; FinMatrix takes over
 * on 1 October 2026, so the opening balances are as at 30 September 2026 and
 * the profit and loss lines are July–September.
 *
 * Amounts are decimal strings; arithmetic is exact (decimal.js).
 */
import Decimal from 'decimal.js';

export interface SampleAccount {
  number: string;
  name: string;
  type: 'Asset' | 'Liability' | 'Equity' | 'Revenue' | 'Expense';
  /** A FinMatrix sub-type (ACCOUNT_SUB_TYPES). */
  kind: string;
  /** Tally group the ledger sits under. */
  tallyGroup: string;
  control?: 'ar' | 'ap' | 'inventory' | 'retained';
}
export interface SampleParty {
  code: string;
  name: string;
  phone: string;
  email: string;
  address: string;
  city: string;
  terms: 'Net 15' | 'Net 30' | 'Net 45' | 'Due on receipt';
  creditLimit: string;
  ntn: string;
}
export interface SampleItem {
  sku: string;
  name: string;
  category: string;
  unit: string;
  cost: string;
  price: string;
  reorder: string;
}
export interface SampleDocument {
  party: string; // party code
  /** QuickBooks Desktop: the "Customer:Job" the document was raised against. */
  job?: string;
  number: string;
  date: string; // ISO
  due: string; // ISO
  original: string;
  open: string;
}
export interface SampleStock {
  sku: string;
  location: string;
  qty: string;
}
export interface SampleBooks {
  company: string;
  fiscalYearStartMonth: number;
  cutoverDate: string;
  openingDate: string;
  accounts: SampleAccount[];
  customers: SampleParty[];
  vendors: SampleParty[];
  items: SampleItem[];
  locations: string[];
  invoices: SampleDocument[];
  bills: SampleDocument[];
  stock: SampleStock[];
  /** Debit-positive balance per account number, as at the opening date. */
  balances: Map<string, string>;
}

const D = (v: Decimal.Value) => new Decimal(v);
export const money = (v: Decimal.Value) => D(v).toFixed(2);

/** Deterministic pseudo-random numbers (xorshift), so samples never change between runs. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

const ACCOUNTS: SampleAccount[] = [
  { number: '1000', name: 'Cash in Hand', type: 'Asset', kind: 'Cash', tallyGroup: 'Cash-in-Hand' },
  { number: '1050', name: 'Meezan Bank Current', type: 'Asset', kind: 'Bank', tallyGroup: 'Bank Accounts' },
  { number: '1060', name: 'HBL Business Account', type: 'Asset', kind: 'Bank', tallyGroup: 'Bank Accounts' },
  { number: '1100', name: 'Accounts Receivable', type: 'Asset', kind: 'Accounts Receivable', tallyGroup: 'Sundry Debtors', control: 'ar' },
  { number: '1200', name: 'Inventory', type: 'Asset', kind: 'Inventory', tallyGroup: 'Stock-in-Hand', control: 'inventory' },
  { number: '1350', name: 'Advance Income Tax', type: 'Asset', kind: 'Prepaid', tallyGroup: 'Loans & Advances (Asset)' },
  { number: '1500', name: 'Warehouse Racking & Equipment', type: 'Asset', kind: 'Fixed Asset', tallyGroup: 'Fixed Assets' },
  { number: '1510', name: 'Delivery Vehicles', type: 'Asset', kind: 'Fixed Asset', tallyGroup: 'Fixed Assets' },
  { number: '1590', name: 'Accumulated Depreciation', type: 'Asset', kind: 'Fixed Asset', tallyGroup: 'Fixed Assets' },
  { number: '2000', name: 'Accounts Payable', type: 'Liability', kind: 'Accounts Payable', tallyGroup: 'Sundry Creditors', control: 'ap' },
  { number: '2300', name: 'Sales Tax Payable', type: 'Liability', kind: 'Tax Payable', tallyGroup: 'Duties & Taxes' },
  { number: '2450', name: 'Accrued Expenses', type: 'Liability', kind: 'Other Liability', tallyGroup: 'Provisions' },
  { number: '2600', name: 'Bank Loan - Meezan', type: 'Liability', kind: 'Notes Payable', tallyGroup: 'Secured Loans' },
  { number: '3000', name: "Owner's Capital", type: 'Equity', kind: 'Owner Equity', tallyGroup: 'Capital Account' },
  { number: '3100', name: 'Retained Earnings', type: 'Equity', kind: 'Retained Earnings', tallyGroup: '', control: 'retained' },
  { number: '4000', name: 'Sales', type: 'Revenue', kind: 'Sales', tallyGroup: 'Sales Accounts' },
  { number: '4050', name: 'Sales Returns & Discounts', type: 'Revenue', kind: 'Sales', tallyGroup: 'Sales Accounts' },
  { number: '5000', name: 'Cost of Goods Sold', type: 'Expense', kind: 'Cost of Goods', tallyGroup: 'Direct Expenses' },
  { number: '6050', name: 'Salaries & Wages', type: 'Expense', kind: 'Payroll', tallyGroup: 'Indirect Expenses' },
  { number: '6060', name: 'Warehouse Rent', type: 'Expense', kind: 'Operating', tallyGroup: 'Indirect Expenses' },
  { number: '6070', name: 'Electricity & Utilities', type: 'Expense', kind: 'Operating', tallyGroup: 'Indirect Expenses' },
  { number: '6080', name: 'Fuel & Delivery', type: 'Expense', kind: 'Operating', tallyGroup: 'Indirect Expenses' },
  { number: '6090', name: 'Depreciation', type: 'Expense', kind: 'Depreciation', tallyGroup: 'Indirect Expenses' },
  { number: '7050', name: 'Bank Charges', type: 'Expense', kind: 'Other Expense', tallyGroup: 'Indirect Expenses' },
];

/** Balances that do not come from detail (debit positive). Retained earnings balances the books. */
const FIXED_BALANCES: Record<string, string> = {
  '1000': '185400.00',
  '1050': '2145780.50',
  '1060': '864215.25',
  '1350': '125000.00',
  '1500': '1850000.00',
  '1510': '4200000.00',
  '1590': '-1236500.00',
  '2300': '-312450.00',
  '2450': '-186300.00',
  '2600': '-2500000.00',
  '3000': '-5000000.00',
  '4000': '-18450600.00',
  '4050': '245300.00',
  '5000': '14256780.00',
  '6050': '1080000.00',
  '6060': '450000.00',
  '6070': '186420.40',
  '6080': '312880.00',
  '6090': '154560.00',
  '7050': '18245.60',
};

const CUSTOMER_NAMES: Array<[string, string]> = [
  ['Al-Madina Karyana Store', 'Lahore'],
  ['Shaheen Super Mart', 'Faisalabad'],
  ['Bismillah Traders', 'Multan'],
  ['Gulshan General Store', 'Karachi'],
  ['Rehman Wholesale', 'Gujranwala'],
  ['New City Pharmacy', 'Islamabad'],
  ['Karachi Cash & Carry', 'Karachi'],
  ['Hamza Brothers', 'Sialkot'],
];
const VENDOR_NAMES: Array<[string, string]> = [
  ['Punjab Foods Ltd', 'Lahore'],
  ['Karachi Packaging Co', 'Karachi'],
  ['Sindh Oil Mills', 'Hyderabad'],
  ['Margalla Logistics', 'Rawalpindi'],
  ['Ravi Beverages', 'Lahore'],
];
const ITEMS: SampleItem[] = [
  { sku: 'RICE-BAS-5KG', name: 'Basmati Rice 5kg', category: 'Grocery', unit: 'bag', cost: '1450.00', price: '1800.00', reorder: '40' },
  { sku: 'ATTA-10KG', name: 'Chakki Atta 10kg', category: 'Grocery', unit: 'bag', cost: '980.00', price: '1150.00', reorder: '60' },
  { sku: 'OIL-COOK-5L', name: 'Cooking Oil 5L Tin', category: 'Grocery', unit: 'tin', cost: '2350.00', price: '2700.00', reorder: '30' },
  { sku: 'GHEE-1KG', name: 'Banaspati Ghee 1kg', category: 'Grocery', unit: 'pack', cost: '520.00', price: '610.00', reorder: '100' },
  { sku: 'SUGAR-50KG', name: 'Sugar 50kg Sack', category: 'Grocery', unit: 'sack', cost: '6800.00', price: '7600.00', reorder: '10' },
  { sku: 'TEA-950G', name: 'Black Tea 950g', category: 'Beverages', unit: 'pack', cost: '1250.00', price: '1490.00', reorder: '50' },
  { sku: 'DAL-MASH-1KG', name: 'Dal Mash 1kg', category: 'Grocery', unit: 'pack', cost: '420.00', price: '520.00', reorder: '80' },
  { sku: 'SOAP-BATH-12', name: 'Bath Soap Carton (12)', category: 'Household', unit: 'carton', cost: '1150.00', price: '1380.00', reorder: '25' },
  { sku: 'DET-1KG', name: 'Detergent Powder 1kg', category: 'Household', unit: 'pack', cost: '380.00', price: '460.00', reorder: '90' },
  { sku: 'MILK-UHT-1L', name: 'UHT Milk 1L', category: 'Beverages', unit: 'pack', cost: '260.00', price: '300.00', reorder: '120' },
  { sku: 'SPICE-MIX-50G', name: 'Spice Mix 50g', category: 'Grocery', unit: 'box', cost: '95.00', price: '130.00', reorder: '200' },
  { sku: 'WATER-1.5L-6', name: 'Mineral Water 1.5L (6)', category: 'Beverages', unit: 'case', cost: '360.00', price: '450.00', reorder: '70' },
];
export const LOCATIONS = ['Main Warehouse Lahore', 'Karachi Godown'];

const iso = (y: number, m: number, d: number) =>
  `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
const addDays = (isoDate: string, days: number) => {
  const t = new Date(`${isoDate}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + days);
  return t.toISOString().slice(0, 10);
};
const termDays: Record<SampleParty['terms'], number> = {
  'Net 15': 15,
  'Net 30': 30,
  'Net 45': 45,
  'Due on receipt': 0,
};

/**
 * The books. `scale` multiplies parties, items and documents (for the large
 * samples); the balances not driven by detail stay the same, and retained
 * earnings always balances the trial balance.
 */
export function sampleBooks(scale = 1): SampleBooks {
  const r = rng(20261001);
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const terms: SampleParty['terms'][] = ['Net 30', 'Net 15', 'Net 45', 'Due on receipt'];
  const party = (kind: 'C' | 'V', i: number, base: [string, string]): SampleParty => {
    const n = i + 1;
    const suffix = i < (kind === 'C' ? CUSTOMER_NAMES.length : VENDOR_NAMES.length) ? '' : ` ${Math.floor(i / 8) + 1}`;
    return {
      code: `${kind}${String(n).padStart(scale > 1 ? 5 : 3, '0')}`,
      name: `${base[0]}${suffix}`,
      phone: `03${int(0, 4)}${int(0, 9)}-${String(int(1000000, 9999999))}`,
      email: `accounts${n}@${kind === 'C' ? 'customer' : 'supplier'}.example.pk`,
      address: `Shop ${int(1, 250)}, Main Bazaar`,
      city: base[1],
      terms: terms[i % terms.length],
      creditLimit: kind === 'C' ? money(int(2, 40) * 50000) : '0.00',
      ntn: `${int(1000000, 9999999)}-${int(0, 9)}`,
    };
  };
  const customers = Array.from({ length: CUSTOMER_NAMES.length * scale }, (_, i) =>
    party('C', i, CUSTOMER_NAMES[i % CUSTOMER_NAMES.length]),
  );
  const vendors = Array.from({ length: VENDOR_NAMES.length * scale }, (_, i) =>
    party('V', i, VENDOR_NAMES[i % VENDOR_NAMES.length]),
  );
  const items =
    scale === 1
      ? ITEMS
      : Array.from({ length: ITEMS.length * scale }, (_, i) => {
          const b = ITEMS[i % ITEMS.length];
          const k = Math.floor(i / ITEMS.length);
          return k === 0 ? b : { ...b, sku: `${b.sku}-${k}`, name: `${b.name} (${k})` };
        });

  // Open documents: dated July–September, some part-paid. The last customer
  // and the last vendor have nothing open (zero balance).
  const docs = (parties: SampleParty[], prefix: string, perParty: number): SampleDocument[] => {
    const out: SampleDocument[] = [];
    let seq = 1001;
    parties.slice(0, -1).forEach((p) => {
      const n = int(1, perParty);
      for (let k = 0; k < n; k++) {
        const date = iso(2026, int(7, 9), int(1, 28));
        const original = D(int(8, 400) * 1250).plus(int(0, 1) ? '0.50' : '0');
        const paid = r() < 0.35 ? original.times(int(1, 6)).dividedBy(10).toDecimalPlaces(0) : D(0);
        out.push({
          party: p.code,
          number: `${prefix}-${seq++}`,
          date,
          due: addDays(date, termDays[p.terms]),
          original: money(original),
          open: money(original.minus(paid)),
        });
      }
    });
    return out;
  };
  const invoices = docs(customers, 'INV', 3);
  const bills = docs(vendors, 'PB', 3);

  // Stock in both locations; one item only in Lahore.
  const stock: SampleStock[] = [];
  items.forEach((it, i) => {
    stock.push({ sku: it.sku, location: LOCATIONS[0], qty: String(int(20, 400)) });
    if (i % 4 !== 3) stock.push({ sku: it.sku, location: LOCATIONS[1], qty: String(int(10, 200)) });
  });

  const cost = new Map(items.map((i) => [i.sku, D(i.cost)]));
  const sumOf = (xs: Decimal[]) => xs.reduce((t, x) => t.plus(x), D(0));
  const balances = new Map<string, string>();
  for (const [n, v] of Object.entries(FIXED_BALANCES)) balances.set(n, money(v));
  balances.set('1100', money(sumOf(invoices.map((d) => D(d.open)))));
  balances.set('2000', money(sumOf(bills.map((d) => D(d.open))).negated()));
  balances.set('1200', money(sumOf(stock.map((s) => D(s.qty).times(cost.get(s.sku)!)))));
  const rest = sumOf([...balances.values()].map((v) => D(v)));
  balances.set('3100', money(rest.negated()));
  if (D(balances.get('3100')!).greaterThanOrEqualTo(0)) {
    throw new Error('sample books: retained earnings came out as a debit; adjust the fixed balances');
  }
  return {
    company: 'Indus Valley Distributors (Pvt) Ltd',
    fiscalYearStartMonth: 7,
    cutoverDate: '2026-10-01',
    openingDate: '2026-09-30',
    accounts: ACCOUNTS,
    customers,
    vendors,
    items,
    locations: LOCATIONS,
    invoices,
    bills,
    stock,
    balances,
  };
}

/** What FinMatrix must hold after importing these books, whatever the format. */
export function expectedResults(b: SampleBooks) {
  const dr = [...b.balances.values()].filter((v) => D(v).greaterThan(0)).reduce((t, v) => t.plus(v), D(0));
  const cost = new Map(b.items.map((i) => [i.sku, D(i.cost)]));
  const byLocation = new Map<string, Decimal>();
  for (const s of b.stock) {
    byLocation.set(s.location, (byLocation.get(s.location) ?? D(0)).plus(D(s.qty).times(cost.get(s.sku)!)));
  }
  const profit = b.accounts
    .filter((a) => a.type === 'Revenue' || a.type === 'Expense')
    .reduce((t, a) => t.minus(b.balances.get(a.number) ?? 0), D(0));
  return {
    trialBalanceTotal: money(dr),
    receivables: b.balances.get('1100')!,
    payables: money(D(b.balances.get('2000')!).negated()),
    inventory: b.balances.get('1200')!,
    inventoryByLocation: Object.fromEntries([...byLocation].map(([k, v]) => [k, money(v)])),
    retainedEarnings: money(D(b.balances.get('3100')!).negated()),
    profitYearToDate: money(profit),
    accounts: b.accounts.length,
    customers: b.customers.length,
    vendors: b.vendors.length,
    items: b.items.length,
    openInvoices: b.invoices.length,
    openBills: b.bills.length,
    stockLines: b.stock.length,
  };
}

export const fmtDate = {
  /** 30/09/2026 */
  dmy: (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`,
  /** 09/30/2026 */
  mdy: (iso: string) => `${iso.slice(5, 7)}/${iso.slice(8, 10)}/${iso.slice(0, 4)}`,
  /** 30-Sep-2026 */
  dMonY: (iso: string) => {
    const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(iso.slice(5, 7)) - 1];
    return `${iso.slice(8, 10)}-${m}-${iso.slice(0, 4)}`;
  },
  /** Sep 30, 2026 */
  monDY: (iso: string) => {
    const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(iso.slice(5, 7)) - 1];
    return `${m} ${Number(iso.slice(8, 10))}, ${iso.slice(0, 4)}`;
  },
};
