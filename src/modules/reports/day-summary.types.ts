/**
 * Day Summary — what the business did on one calendar day.
 *
 * A document belongs to the day on its own document date (invoice_date,
 * order_date, payment_date, …), so every figure here agrees with the P&L and
 * the other reports for that day. Documents entered on the day but dated
 * earlier are reported separately as "back-dated".
 *
 * Money is a number rounded to 2 dp, like every other report; it is summed as
 * numeric in SQL and rounded once.
 */

/** Every document type the summary counts, in display order. */
export const DAY_DOC_KINDS = [
  'invoice',
  'sales_order',
  'estimate',
  'receipt',
  'credit_memo',
  'bill',
  'purchase_order',
  'vendor_payment',
  'vendor_credit',
] as const;
export type DayDocKind = (typeof DAY_DOC_KINDS)[number];

/** Day Book filters beyond a single document type. */
export const DAY_ENTRY_FILTERS = [
  'all',
  'backdated',
  'drafts',
  'voided',
  'cancelled',
] as const;
export type DayEntryFilter = (typeof DAY_ENTRY_FILTERS)[number] | DayDocKind;

/** How the Day Book is ordered. `newest` (by entry time) is the default. */
export const DAY_ENTRY_SORTS = [
  'newest',
  'oldest',
  'amount_desc',
  'amount_asc',
] as const;
export type DayEntrySort = (typeof DAY_ENTRY_SORTS)[number];

export interface DayFigure {
  count: number;
  total: number;
}

/** A headline figure with what to compare it against. */
export interface DayKpi extends DayFigure {
  previousDay: DayFigure;
  sameDayLastWeek: DayFigure;
  /** Totals for the 7 days ending on `date`, oldest first (see trendDates). */
  trend: number[];
}

export interface DayDocumentRow extends DayFigure {
  kind: DayDocKind;
}

export interface DayMethodRow {
  /** cash, check, bank_transfer, credit_card, other. */
  method: string;
  /** Customer receipts. */
  received: number;
  /** Vendor payments. */
  paid: number;
}

export interface DayPartyRow {
  id: string;
  name: string;
  count: number;
  total: number;
}

export interface DayItemRow {
  /** Null for a free-text line with no stock item. */
  itemId: string | null;
  name: string;
  quantity: number;
  /** Pre-tax, after the invoice's discount (same basis as item reports). */
  total: number;
}

/** One local hour of the day: what was sold and collected in it. */
export interface DayHourRow {
  /** 0–23, company time. */
  hour: number;
  sales: number;
  salesCount: number;
  received: number;
  receivedCount: number;
}

export interface DayUserRow {
  /** Null for documents no person can be credited with. */
  userId: string | null;
  name: string;
  invoices: DayFigure;
  salesOrders: DayFigure;
  estimates: DayFigure;
  receipts: DayFigure;
  /** Every counted document this person prepared that day. */
  documents: number;
}

export interface DayAttention {
  /** Entered on this day, dated earlier. */
  backdated: number;
  /** Invoices and bills dated this day still in draft (not posted). */
  drafts: number;
  /** Sales orders dated this day that are cancelled. */
  cancelledOrders: number;
  /** Invoices, receipts, bills, … voided or deleted on this day. Owner only. */
  voided: DayFigure | null;
}

export interface DaySummaryResponse {
  date: string;
  /** The company's business day right now. */
  today: string;
  timezone: string;
  currency: string;
  scope: {
    /** True for staff: only documents they prepared. */
    ownOnly: boolean;
    /** The person the figures are limited to, if any. */
    createdBy: { id: string; name: string } | null;
  };
  /** The document types this company's plan has, in display order. */
  kinds: DayDocKind[];
  headline: {
    sales: DayKpi;
    received: DayKpi;
    /** Null when the plan has no sales orders. */
    orders: DayKpi | null;
    purchases: DayKpi;
  };
  /** The 7 dates `trend` arrays cover, oldest first. */
  trendDates: string[];
  documents: DayDocumentRow[];
  /** The day's posted invoices, broken down. */
  sales: {
    subtotal: number;
    discount: number;
    tax: number;
    total: number;
    /** Still owed on them now (credit sales not yet collected). */
    unpaid: number;
    /** Customer returns (credit memos) dated the day, tax included. */
    returns: number;
    /** total − returns: what the day's sales came to after returns. */
    net: number;
  };
  cash: {
    methods: DayMethodRow[];
    received: number;
    paid: number;
    net: number;
  };
  topCustomers: DayPartyRow[];
  topItems: DayItemRow[];
  /**
   * The day's counted invoices and receipts by the local hour they were
   * entered — when the business was busy. 24 rows, 0 to 23.
   */
  hourly: DayHourRow[];
  /** Owner, everyone's view only. */
  team: DayUserRow[] | null;
  /** Owner only: the people the "Created by" filter can pick. */
  members: Array<{ id: string; name: string; role: string }> | null;
  /** The day's P&L from the general ledger. Owner, everyone's view only. */
  profit: {
    revenue: number;
    cogs: number;
    grossProfit: number;
    expenses: number;
    netIncome: number;
  } | null;
  attention: DayAttention;
  /** Nothing at all was dated or entered on this day. */
  isEmpty: boolean;
  generatedAt: string;
}

export interface DayEntry {
  kind: DayDocKind;
  id: string;
  number: string | null;
  /** The document's own date. */
  date: string;
  /** When it was entered (or, for `voided`, when it was voided / deleted). */
  createdAt: string;
  partyId: string | null;
  partyName: string | null;
  amount: number;
  status: string | null;
  /** Who prepared it (for `voided`: who voided or deleted it). */
  createdBy: { id: string; name: string } | null;
  /** Entered on a later day than it is dated. */
  backdated: boolean;
  /** Included in the day's totals (not draft, void or cancelled). */
  counted: boolean;
  /** The document no longer exists (deleted); nothing to open. */
  deleted: boolean;
}

export interface DayEntriesResponse {
  date: string;
  filter: DayEntryFilter;
  /** The search applied (number or party), or null. */
  q: string | null;
  sort: DayEntrySort;
  /** This page's rows. */
  items: DayEntry[];
  /** Rows matching the filter and search, across every page. */
  total: number;
  /** Their amounts the day's totals count, across every page. */
  countedTotal: number;
  /** Their amounts the totals leave out (drafts, voids, cancelled). */
  excludedTotal: number;
  page: number;
  limit: number;
  /** ceil(total / limit); 0 when nothing matches. */
  pages: number;
}

// ── Item-wise sales ─────────────────────────────────────────────────────────

/** What the item sheet compares itself with (the page's Compare control). */
export const DAY_ITEM_COMPARES = ['previous', 'lastWeek'] as const;
export type DayItemCompare = (typeof DAY_ITEM_COMPARES)[number];

/**
 * One line of the item-wise sales sheet: a stock item, or a service or charge
 * (a line with no stock item, named by its wording).
 *
 * Quantities follow the stock: `sold` are priced units sold (invoices and
 * delivered goods), `free` are units given at price 0, `returned` are units
 * customers sent back (credit memos), and `net` = sold + free − returned is
 * what left the shelves. `value` is net sales: before tax, after each
 * invoice's discount, less returns — the basis the P&L and item reports use.
 */
export interface DayItemSheetRow {
  kind: 'item' | 'service';
  /** Null for a service or charge. */
  itemId: string | null;
  code: string | null;
  name: string;
  unit: string | null;
  /** The item's category, trimmed; null when it has none. */
  category: string | null;
  /** The agency (principal) the item comes from, if set. */
  agency: string | null;
  sold: number;
  free: number;
  returned: number;
  net: number;
  value: number;
  /** Value of the returns alone (a positive figure, inside `value`). */
  returnsValue: number;
  /**
   * Owner only (null for staff), and stock items only (null for a service or
   * charge, which carries no cost of goods): cost of what left the shelves.
   */
  cost: number | null;
  profit: number | null;
  /** profit / value as a percentage, 1 dp; null when value is 0. */
  margin: number | null;
  /** Some lines carry no recorded cost, so cost and profit are understated. */
  costMissing: boolean;
  /** Net sales in the comparison period; null when no comparison is asked. */
  compareValue: number | null;
}

/** Sold in the comparison period only — so a group's comparison adds up. */
export interface DayItemCompareOnly {
  kind: 'item' | 'service';
  itemId: string | null;
  name: string;
  category: string | null;
  agency: string | null;
  compareValue: number;
}

export interface DayItemSheetTotals {
  /** Rows on the sheet (stock items and services). */
  lines: number;
  sold: number;
  free: number;
  returned: number;
  net: number;
  value: number;
  returnsValue: number;
  cost: number | null;
  profit: number | null;
  margin: number | null;
  compareValue: number | null;
}

/** An item sold in the period that now needs reordering. */
export interface DayReorderRow {
  itemId: string;
  code: string;
  name: string;
  unit: string | null;
  onHand: number;
  /** 0 when the item has none set. */
  reorderPoint: number;
  /** The quantity the item says to reorder; 0 when none set. */
  reorderQuantity: number;
  /** At or below zero. */
  outOfStock: boolean;
}

export interface DayItemSheet {
  from: string;
  to: string;
  today: string;
  currency: string;
  scope: DaySummaryResponse['scope'];
  compare: DayItemCompare | null;
  compareFrom: string | null;
  compareTo: string | null;
  /** Stock items first, then services and charges. Sorted by value. */
  rows: DayItemSheetRow[];
  compareOnly: DayItemCompareOnly[];
  totals: DayItemSheetTotals;
  /** Any units were given free in the period (shows the Free column). */
  hasFree: boolean;
  /** The viewer sees cost, profit and margin (owners). */
  showCost: boolean;
  /**
   * How net sales tie to the documents: the period's invoices before tax and
   * after discounts, less its returns before tax. `matches` is true when the
   * sheet adds up to exactly that.
   */
  reconciliation: {
    salesBeforeTax: number;
    returns: number;
    netSales: number;
    matches: boolean;
  };
  /** Items that need reordering; null when the plan has no inventory. */
  reorder: DayReorderRow[] | null;
  generatedAt: string;
}

export interface DaySummarySchedule {
  enabled: boolean;
  /**
   * Local hour (0–23) the digest goes out. From 12:00 it covers that same
   * day; before noon it is a morning recap of the day before.
   */
  hour: number;
  email: boolean;
  timezone: string;
  /** The last day a digest covered, if any. */
  lastSent: string | null;
}
