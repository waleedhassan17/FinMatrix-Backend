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
  items: DayEntry[];
  total: number;
  page: number;
  limit: number;
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
