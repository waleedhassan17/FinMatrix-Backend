import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  businessTimezone,
  businessToday,
} from '../../common/utils/business-date.util';
import { companyFeatures } from '../../common/features/company-features.util';
import { FeatureKey } from '../../common/features/feature-map';
import { ReportsService } from './reports.service';
import {
  DAY_DOC_KINDS,
  DayDocKind,
  DayEntriesResponse,
  DayEntry,
  DayEntryFilter,
  DayEntrySort,
  DayFigure,
  DayHourRow,
  DayItemCompare,
  DayItemSheet,
  DayKpi,
  DayPurchasePosition,
  DayPurchasing,
  DayReorderRow,
  DaySummaryResponse,
  DaySummarySchedule,
  DayUserRow,
} from './day-summary.types';
import {
  bestSellers,
  buildItemSheet,
  buildKpi,
  comparePeriod,
  ItemFigures,
  localDayBounds,
  num,
  r2,
  summaryWindow,
} from './day-summary.util';

/** Who is asking: staff only ever see what they prepared themselves. */
export interface DaySummaryViewer {
  id: string;
  role: string;
}

/**
 * A purchase order called off before anything arrived: closed with nothing
 * received (the same rule as messaging's isPoWithdrawal).
 */
const PO_WITHDRAWN = `(x.status = 'closed' AND NOT EXISTS (
  SELECT 1 FROM purchase_order_lines pol
   WHERE pol.order_id = x.id AND pol.received_qty > 0))`;

/**
 * How one document table maps onto a Day Book row. Every arm yields the same
 * columns, so the day's documents can be read as one UNION ALL:
 *   kind, id, number, doc_date, created_at, status, amount, method,
 *   party_id, party_name, creator_id, counted
 */
interface Arm {
  table: string;
  dateCol: string;
  number: string;
  amount: string;
  status: string;
  method: string;
  partyCol: string;
  partyTable: 'customers' | 'vendors';
  partyName: string;
  /** Who prepared it when no approval request says otherwise. */
  creator: string;
  joinJournal: boolean;
  /** In the day's totals: posted, not void, not cancelled. */
  counted: string;
  /** Rows that are never part of a day at all. */
  exclude?: string;
  /** The plan feature the document type belongs to, if it is optional. */
  feature?: FeatureKey;
}

/**
 * Invoices, sales orders, estimates and purchase orders record their creator
 * (purchase orders only since 1791300000000; older ones have none). Receipts,
 * bills and vendor payments do not, so the person comes from the journal entry
 * the document posted.
 *
 * Migrated documents (`source = 'migration'`) are the old books' open items:
 * they were dated long before they were imported, so counting them would put
 * months of history into one day as "back-dated". They are left out entirely,
 * as every other report leaves them out.
 */
const ARMS: Record<DayDocKind, Arm> = {
  invoice: {
    table: 'invoices',
    dateCol: 'invoice_date',
    number: 'x.invoice_number',
    amount: 'x.total',
    status: 'x.status',
    method: 'NULL',
    partyCol: 'customer_id',
    partyTable: 'customers',
    partyName: 'p.name',
    creator: 'x.created_by',
    joinJournal: false,
    counted: `x.status NOT IN ('draft', 'void')`,
    exclude: `x.source = 'migration'`,
  },
  sales_order: {
    table: 'sales_orders',
    dateCol: 'order_date',
    number: 'x.order_number',
    amount: 'x.total',
    status: 'x.status',
    method: 'NULL',
    partyCol: 'customer_id',
    partyTable: 'customers',
    partyName: 'p.name',
    creator: 'x.created_by',
    joinJournal: false,
    counted: `x.status <> 'cancelled'`,
    feature: 'salesOrders',
  },
  estimate: {
    table: 'estimates',
    dateCol: 'estimate_date',
    number: 'x.estimate_number',
    amount: 'x.total',
    status: 'x.status',
    method: 'NULL',
    partyCol: 'customer_id',
    partyTable: 'customers',
    partyName: 'p.name',
    creator: 'x.created_by',
    joinJournal: false,
    counted: 'true',
    feature: 'estimates',
  },
  receipt: {
    table: 'payments',
    dateCol: 'payment_date',
    number: 'x.payment_number',
    amount: 'x.amount',
    status: 'NULL',
    method: 'x.payment_method',
    partyCol: 'customer_id',
    partyTable: 'customers',
    partyName: 'p.name',
    creator: 'je.created_by',
    joinJournal: true,
    counted: 'true',
  },
  credit_memo: {
    table: 'credit_memos',
    dateCol: 'date',
    number: 'x.credit_memo_number',
    amount: 'x.total',
    status: 'x.status',
    method: 'NULL',
    partyCol: 'customer_id',
    partyTable: 'customers',
    partyName: 'p.name',
    creator: 'COALESCE(x.created_by, je.created_by)',
    joinJournal: true,
    counted: `x.status <> 'void'`,
    feature: 'creditMemos',
  },
  bill: {
    table: 'bills',
    dateCol: 'bill_date',
    number: 'x.bill_number',
    amount: 'x.total',
    status: 'x.status',
    method: 'NULL',
    partyCol: 'vendor_id',
    partyTable: 'vendors',
    partyName: 'p.company_name',
    creator: 'je.created_by',
    joinJournal: true,
    counted: `x.status NOT IN ('draft', 'void')`,
    exclude: `x.source = 'migration'`,
  },
  purchase_order: {
    table: 'purchase_orders',
    dateCol: 'order_date',
    number: 'x.po_number',
    amount: 'x.total',
    // A purchase order has no cancelled status: one called off before anything
    // arrived is closed with nothing received, and shows as withdrawn.
    status: `CASE WHEN ${PO_WITHDRAWN} THEN 'withdrawn' ELSE x.status END`,
    method: 'NULL',
    partyCol: 'vendor_id',
    partyTable: 'vendors',
    partyName: 'p.company_name',
    creator: 'x.created_by',
    joinJournal: false,
    // Placed: issued to the supplier, and not called off.
    counted: `x.status <> 'draft' AND NOT (${PO_WITHDRAWN})`,
    feature: 'purchaseOrders',
  },
  vendor_payment: {
    table: 'bill_payments',
    dateCol: 'payment_date',
    number: 'x.reference',
    amount: 'x.total_amount',
    status: 'NULL',
    method: 'x.payment_method',
    partyCol: 'vendor_id',
    partyTable: 'vendors',
    partyName: 'p.company_name',
    creator: 'je.created_by',
    joinJournal: true,
    counted: 'true',
  },
  vendor_credit: {
    table: 'vendor_credits',
    dateCol: 'date',
    number: 'x.vendor_credit_number',
    amount: 'x.total',
    status: 'x.status',
    method: 'NULL',
    partyCol: 'vendor_id',
    partyTable: 'vendors',
    partyName: 'p.company_name',
    creator: 'COALESCE(x.created_by, je.created_by)',
    joinJournal: true,
    counted: `x.status <> 'void'`,
    feature: 'creditMemos',
  },
};

/** The document types whose drafts the owner is told about. */
const DRAFT_KINDS: readonly DayDocKind[] = [
  'invoice',
  'bill',
  'purchase_order',
];
const DRAFT_KINDS_SQL = `(${DRAFT_KINDS.map((k) => `'${k}'`).join(', ')})`;

/** Orders called off: cancelled sales orders and withdrawn purchase orders. */
const CALLED_OFF_SQL = `((d.kind = 'sales_order' AND d.status = 'cancelled')
  OR (d.kind = 'purchase_order' AND d.status = 'withdrawn'))`;

/** audit_trail resource types → the Day Book kind they are shown as. */
const AUDIT_KINDS: Record<string, DayDocKind> = {
  invoice: 'invoice',
  payment: 'receipt',
  bill: 'bill',
  bill_payment: 'vendor_payment',
  credit_memo: 'credit_memo',
  vendor_credit: 'vendor_credit',
};

/**
 * ORDER BY for each Day Book sort, ending on a unique key so a row never
 * moves between pages when two share a time or an amount.
 */
const ENTRY_ORDER: Record<DayEntrySort, (t: string, key?: string) => string> = {
  newest: (t, key = 'id') => `${t}.created_at DESC, ${t}.${key}`,
  oldest: (t, key = 'id') => `${t}.created_at ASC, ${t}.${key}`,
  amount_desc: (t, key = 'id') =>
    `${t}.amount DESC, ${t}.created_at DESC, ${t}.${key}`,
  amount_asc: (t, key = 'id') =>
    `${t}.amount ASC, ${t}.created_at DESC, ${t}.${key}`,
};

/** A positional-parameter list: add() returns the placeholder to splice in. */
class Params {
  readonly values: unknown[] = [];
  add(v: unknown): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
}

/** How each arm is restricted in time. */
type DateFilter =
  | { mode: 'dated'; from: string; to: string }
  /** Entered within [start, end) but dated before `before`. */
  | { mode: 'backdated'; start: Date; end: Date; before: string };

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class DaySummaryService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly reports: ReportsService,
  ) {}

  // ── Context ──────────────────────────────────────────────────────────────

  /** The company's zone, currency and the document types its plan has. */
  async context(companyId: string): Promise<{
    timezone: string;
    currency: string;
    kinds: DayDocKind[];
    /** The plan keeps stock (reorder alerts need it). */
    inventory: boolean;
  }> {
    const [row] = await this.dataSource.query(
      `SELECT cs.timezone, cs.default_currency, c.home_currency
         FROM companies c
         LEFT JOIN company_settings cs ON cs.company_id = c.id
        WHERE c.id = $1`,
      [companyId],
    );
    const features = await companyFeatures(this.dataSource.manager, companyId);
    return {
      timezone: businessTimezone(row?.timezone),
      currency: row?.home_currency || row?.default_currency || 'PKR',
      kinds: DAY_DOC_KINDS.filter((k) => {
        const f = ARMS[k].feature;
        return !f || features[f];
      }),
      inventory: !!features.inventory,
    };
  }

  /** The business day it is now for this company. */
  async today(companyId: string): Promise<string> {
    return businessToday((await this.context(companyId)).timezone);
  }

  /**
   * Whose documents a request may see. Staff: their own, whatever they ask
   * for. An owner: everyone's, or one member's when `createdBy` names one.
   */
  private async scope(
    companyId: string,
    viewer: DaySummaryViewer,
    createdBy?: string | null,
  ): Promise<{
    ownOnly: boolean;
    creator: { id: string; name: string } | null;
  }> {
    if (viewer.role !== 'admin') {
      return {
        ownOnly: true,
        creator: { id: viewer.id, name: await this.userName(viewer.id) },
      };
    }
    if (!createdBy) return { ownOnly: false, creator: null };
    if (!UUID_RE.test(createdBy)) {
      throw new BadRequestException({
        code: 'INVALID_CREATED_BY',
        message: 'createdBy must be the id of a member of this company.',
      });
    }
    const [member] = await this.dataSource.query(
      `SELECT u.id, u.display_name FROM user_companies uc
         JOIN users u ON u.id = uc.user_id
        WHERE uc.company_id = $1 AND uc.user_id = $2`,
      [companyId, createdBy],
    );
    if (!member) {
      throw new BadRequestException({
        code: 'INVALID_CREATED_BY',
        message: 'createdBy must be the id of a member of this company.',
      });
    }
    return {
      ownOnly: false,
      creator: { id: member.id, name: member.display_name || 'Unnamed' },
    };
  }

  private async userName(userId: string): Promise<string> {
    const [u] = await this.dataSource.query(
      `SELECT display_name FROM users WHERE id = $1`,
      [userId],
    );
    return u?.display_name || 'Me';
  }

  // ── SQL building ─────────────────────────────────────────────────────────

  private armSql(kind: DayDocKind, p: Params, company: string, f: DateFilter) {
    const a = ARMS[kind];
    const when =
      f.mode === 'dated'
        ? `x.${a.dateCol} BETWEEN ${p.add(f.from)} AND ${p.add(f.to)}`
        : `x.created_at >= ${p.add(f.start)} AND x.created_at < ${p.add(f.end)}
           AND x.${a.dateCol} < ${p.add(f.before)}`;
    return `
      SELECT '${kind}'::text AS kind,
             x.id,
             ${a.number}::text AS number,
             to_char(x.${a.dateCol}, 'YYYY-MM-DD') AS doc_date,
             x.created_at,
             ${a.status}::text AS status,
             COALESCE(${a.amount}, 0)::numeric AS amount,
             ${a.method}::text AS method,
             x.${a.partyCol} AS party_id,
             ${a.partyName}::text AS party_name,
             COALESCE(ar.requested_by, ${a.creator}) AS creator_id,
             (${a.counted}) AS counted
        FROM ${a.table} x
        LEFT JOIN ${a.partyTable} p ON p.id = x.${a.partyCol}
        ${a.joinJournal ? 'LEFT JOIN journal_entries je ON je.id = x.journal_entry_id' : ''}
        -- A document an owner approved was prepared by whoever asked for it.
        LEFT JOIN LATERAL (
          SELECT r.requested_by FROM approval_requests r
           WHERE r.company_id = x.company_id AND r.result_id = x.id
             AND r.status = 'approved' AND r.type <> 'void'
           ORDER BY r.created_at
           LIMIT 1
        ) ar ON true
       WHERE x.company_id = ${company}
         ${a.exclude ? `AND NOT (${a.exclude})` : ''}
         AND ${when}`;
  }

  /** The chosen kinds as one row set, with `p` holding its parameters. */
  private docs(kinds: DayDocKind[], p: Params, company: string, f: DateFilter) {
    if (kinds.length === 0) {
      // Keeps the outer query valid when a filter leaves nothing to read.
      return `SELECT NULL::text AS kind, NULL::uuid AS id, NULL::text AS number,
                     NULL::text AS doc_date, NULL::timestamptz AS created_at,
                     NULL::text AS status, 0::numeric AS amount, NULL::text AS method,
                     NULL::uuid AS party_id, NULL::text AS party_name,
                     NULL::uuid AS creator_id, false AS counted
               WHERE false`;
    }
    return kinds
      .map((k) => `(${this.armSql(k, p, company, f)})`)
      .join('\nUNION ALL\n');
  }

  /** `AND d.creator_id = $n` when the view is limited to one person. */
  private creatorClause(p: Params, creatorId: string | null): string {
    return creatorId ? `AND d.creator_id = ${p.add(creatorId)}` : '';
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  async summary(
    companyId: string,
    viewer: DaySummaryViewer,
    opts: { date?: string; createdBy?: string | null } = {},
  ): Promise<DaySummaryResponse> {
    const ctx = await this.context(companyId);
    const today = businessToday(ctx.timezone);
    const date = opts.date || today;
    const scope = await this.scope(companyId, viewer, opts.createdBy);
    const creatorId = scope.creator?.id ?? null;
    const owner = !scope.ownOnly;
    const everyone = owner && !creatorId;
    const w = summaryWindow(date);
    const bounds = localDayBounds(date, ctx.timezone);
    const day: DateFilter = { mode: 'dated', from: date, to: date };
    const has = (k: DayDocKind) => ctx.kinds.includes(k);
    const buying = has('purchase_order');

    const [
      series,
      backdated,
      team,
      topCustomers,
      itemsToday,
      cash,
      sales,
      voided,
      profit,
      members,
      hourly,
      receivedByDate,
      buyingExtras,
    ] = await Promise.all([
      this.series(companyId, ctx.kinds, date, w.from, creatorId),
      this.backdatedCount(companyId, ctx.kinds, date, bounds, creatorId),
      everyone ? this.team(companyId, ctx.kinds, day) : null,
      this.topCustomers(companyId, day, creatorId),
      this.itemFigures(companyId, ctx.kinds, day, creatorId),
      this.cash(companyId, day, creatorId),
      this.invoiceBreakdown(companyId, ctx.kinds, day, creatorId),
      owner ? this.voidedFigure(companyId, bounds, creatorId) : null,
      everyone ? this.reports.profitLoss(companyId, date, date) : null,
      owner ? this.members(companyId) : null,
      this.hourly(companyId, ctx.kinds, day, ctx.timezone, creatorId),
      buying ? this.receivedSeries(companyId, w.from, date, creatorId) : null,
      buying
        ? this.purchasingExtras(companyId, ctx.kinds, day, creatorId, {
            position: everyone,
            today,
          })
        : null,
    ]);

    const kpi = (k: DayDocKind): DayKpi =>
      buildKpi(series.byKind.get(k) ?? new Map(), date);
    const figureOn = (k: DayDocKind): DayFigure => {
      const f = series.byKind.get(k)?.get(date);
      return { count: f?.count ?? 0, total: r2(f?.total ?? 0) };
    };

    const goodsReceived = receivedByDate
      ? buildKpi(receivedByDate, date)
      : null;

    const methods = cash.methods;
    const received = r2(methods.reduce((t, m) => t + m.received, 0));
    const paid = r2(methods.reduce((t, m) => t + m.paid, 0));

    return {
      date,
      today,
      timezone: ctx.timezone,
      currency: ctx.currency,
      scope: { ownOnly: scope.ownOnly, createdBy: scope.creator },
      kinds: ctx.kinds,
      headline: {
        sales: kpi('invoice'),
        received: kpi('receipt'),
        orders: has('sales_order') ? kpi('sales_order') : null,
        purchases: kpi('bill'),
        purchaseOrders: buying ? kpi('purchase_order') : null,
        goodsReceived,
      },
      trendDates: w.trendDates,
      documents: ctx.kinds.map((kind) => ({ kind, ...figureOn(kind) })),
      sales,
      cash: { methods, received, paid, net: r2(received - paid) },
      topCustomers,
      // The item-wise sheet's own figures, so the two always agree.
      topItems: bestSellers(itemsToday),
      hourly,
      team,
      members,
      profit: profit
        ? {
            revenue: profit.revenue,
            cogs: profit.cogs,
            grossProfit: profit.grossProfit,
            expenses: profit.expenses,
            netIncome: profit.netIncome,
          }
        : null,
      attention: {
        backdated,
        drafts: series.drafts,
        cancelledOrders: series.cancelled,
        voided,
      },
      purchasing:
        buyingExtras && goodsReceived
          ? {
              placed: figureOn('purchase_order'),
              received: {
                count: goodsReceived.count,
                total: goodsReceived.total,
              },
              ...buyingExtras,
            }
          : null,
      isEmpty:
        series.rowsOnDate === 0 &&
        backdated === 0 &&
        (voided?.count ?? 0) === 0 &&
        (goodsReceived?.count ?? 0) === 0,
      generatedAt: new Date().toISOString(),
    };
  }

  /** Counts and totals per kind per date over the week to `date`. */
  private async series(
    companyId: string,
    kinds: DayDocKind[],
    date: string,
    from: string,
    creatorId: string | null,
  ) {
    const p = new Params();
    const company = p.add(companyId);
    const docs = this.docs(kinds, p, company, {
      mode: 'dated',
      from,
      to: date,
    });
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT d.kind, d.doc_date,
              count(*) FILTER (WHERE d.counted)::int AS n,
              COALESCE(sum(d.amount) FILTER (WHERE d.counted), 0) AS total,
              count(*)::int AS all_n,
              count(*) FILTER (WHERE d.status = 'draft'
                                 AND d.kind IN ${DRAFT_KINDS_SQL})::int AS drafts,
              count(*) FILTER (WHERE ${CALLED_OFF_SQL})::int AS cancelled
         FROM (${docs}) d
        WHERE true ${this.creatorClause(p, creatorId)}
        GROUP BY d.kind, d.doc_date`,
      p.values,
    );
    const byKind = new Map<DayDocKind, Map<string, DayFigure>>();
    let drafts = 0;
    let cancelled = 0;
    let rowsOnDate = 0;
    for (const r of rows) {
      const kind = r.kind as DayDocKind;
      const d = String(r.doc_date);
      if (!byKind.has(kind)) byKind.set(kind, new Map());
      byKind.get(kind)!.set(d, { count: num(r.n), total: num(r.total) });
      if (d === date) {
        drafts += num(r.drafts);
        cancelled += num(r.cancelled);
        rowsOnDate += num(r.all_n);
      }
    }
    return { byKind, drafts, cancelled, rowsOnDate };
  }

  private async backdatedCount(
    companyId: string,
    kinds: DayDocKind[],
    date: string,
    bounds: { start: Date; end: Date },
    creatorId: string | null,
  ): Promise<number> {
    const p = new Params();
    const company = p.add(companyId);
    const docs = this.docs(kinds, p, company, {
      mode: 'backdated',
      start: bounds.start,
      end: bounds.end,
      before: date,
    });
    const [row] = await this.dataSource.query(
      `SELECT count(*)::int AS n FROM (${docs}) d
        WHERE true ${this.creatorClause(p, creatorId)}`,
      p.values,
    );
    return num(row?.n);
  }

  /** Per person: what they prepared on the day (counted documents only). */
  private async team(
    companyId: string,
    kinds: DayDocKind[],
    day: DateFilter,
  ): Promise<DayUserRow[]> {
    const p = new Params();
    const company = p.add(companyId);
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT d.creator_id, u.display_name, d.kind,
              count(*)::int AS n, COALESCE(sum(d.amount), 0) AS total
         FROM (${this.docs(kinds, p, company, day)}) d
         LEFT JOIN users u ON u.id = d.creator_id
        WHERE d.counted
        GROUP BY d.creator_id, u.display_name, d.kind`,
      p.values,
    );
    const people = new Map<string, DayUserRow>();
    const zero = (): DayFigure => ({ count: 0, total: 0 });
    for (const r of rows) {
      const key = (r.creator_id as string | null) ?? '';
      if (!people.has(key)) {
        people.set(key, {
          userId: (r.creator_id as string | null) ?? null,
          name: r.creator_id
            ? (r.display_name as string) || 'Unnamed'
            : 'Not recorded',
          invoices: zero(),
          salesOrders: zero(),
          estimates: zero(),
          receipts: zero(),
          purchaseOrders: zero(),
          documents: 0,
        });
      }
      const row = people.get(key)!;
      const fig = { count: num(r.n), total: r2(num(r.total)) };
      row.documents += fig.count;
      if (r.kind === 'invoice') row.invoices = fig;
      else if (r.kind === 'sales_order') row.salesOrders = fig;
      else if (r.kind === 'estimate') row.estimates = fig;
      else if (r.kind === 'receipt') row.receipts = fig;
      else if (r.kind === 'purchase_order') row.purchaseOrders = fig;
    }
    return [...people.values()].sort(
      (a, b) =>
        // People before the "not recorded" bucket, busiest first.
        Number(a.userId === null) - Number(b.userId === null) ||
        b.documents - a.documents ||
        b.invoices.total - a.invoices.total,
    );
  }

  /**
   * Stock received against purchase orders per date, at cost (the receipts'
   * inventory value, net of corrections), with the number of purchase orders
   * goods arrived on. Credited to whoever received them.
   */
  private async receivedSeries(
    companyId: string,
    from: string,
    to: string,
    creatorId: string | null,
  ): Promise<Map<string, DayFigure>> {
    const p = new Params();
    const company = p.add(companyId);
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT to_char(m.date, 'YYYY-MM-DD') AS day,
              count(DISTINCT m.source_id)::int AS n,
              COALESCE(sum(m.value_change), 0) AS total
         FROM inventory_movements m
        WHERE m.company_id = ${company}
          AND m.type = 'receipt' AND m.source_type = 'purchase_order'
          AND m.date BETWEEN ${p.add(from)} AND ${p.add(to)}
          ${creatorId ? `AND m.created_by = ${p.add(creatorId)}` : ''}
        GROUP BY 1`,
      p.values,
    );
    return new Map(
      rows.map((r) => [
        String(r.day),
        { count: num(r.n), total: num(r.total) },
      ]),
    );
  }

  /**
   * The buying side beyond the headline: suppliers ordered from, bills raised
   * from purchase orders, and — for the owner's whole-company view — where
   * the purchase orders stand now.
   */
  private async purchasingExtras(
    companyId: string,
    kinds: DayDocKind[],
    day: DateFilter,
    creatorId: string | null,
    opts: { position: boolean; today: string },
  ): Promise<Pick<DayPurchasing, 'billed' | 'topVendors' | 'position'>> {
    const vendors = async () => {
      const p = new Params();
      const company = p.add(companyId);
      const rows: Array<Record<string, unknown>> = await this.dataSource.query(
        `SELECT d.party_id, d.party_name,
                count(*)::int AS n, COALESCE(sum(d.amount), 0) AS total
           FROM (${this.docs(['purchase_order'], p, company, day)}) d
          WHERE d.counted ${this.creatorClause(p, creatorId)}
          GROUP BY d.party_id, d.party_name
          ORDER BY total DESC, n DESC
          LIMIT 5`,
        p.values,
      );
      return rows.map((r) => ({
        id: String(r.party_id),
        name: (r.party_name as string) || 'Unnamed supplier',
        count: num(r.n),
        total: r2(num(r.total)),
      }));
    };
    const billed = async (): Promise<DayFigure> => {
      if (!kinds.includes('bill')) return { count: 0, total: 0 };
      const p = new Params();
      const company = p.add(companyId);
      const [r] = await this.dataSource.query(
        `SELECT count(*)::int AS n, COALESCE(sum(d.amount), 0) AS total
           FROM (${this.docs(['bill'], p, company, day)}) d
           JOIN bills b ON b.id = d.id AND b.purchase_order_id IS NOT NULL
          WHERE d.counted ${this.creatorClause(p, creatorId)}`,
        p.values,
      );
      return { count: num(r?.n), total: r2(num(r?.total)) };
    };
    const [topVendors, billedFig, position] = await Promise.all([
      vendors(),
      billed(),
      opts.position ? this.purchasePosition(companyId, opts.today) : null,
    ]);
    return { topVendors, billed: billedFig, position };
  }

  /**
   * Where the company's purchase orders stand now: still to arrive, overdue,
   * and received but not yet billed. Not tied to the day being viewed —
   * received and billed quantities are kept as they stand, not by date.
   */
  private async purchasePosition(
    companyId: string,
    today: string,
  ): Promise<DayPurchasePosition> {
    const [r] = await this.dataSource.query(
      `WITH po AS (
         SELECT x.id, x.status, x.expected_date,
                COALESCE(sum(GREATEST(l.ordered_qty - l.received_qty, 0)
                              * l.unit_cost * (1 + COALESCE(l.tax_rate, 0) / 100)), 0) AS to_come,
                COALESCE(sum(l.grni_accrued - l.grni_cleared), 0) AS grni
           FROM purchase_orders x
           LEFT JOIN purchase_order_lines l ON l.order_id = x.id
          WHERE x.company_id = $1 AND x.status <> 'draft'
          GROUP BY x.id
       )
       SELECT count(*) FILTER (WHERE status IN ('sent', 'partial'))::int AS open_n,
              COALESCE(sum(to_come) FILTER (WHERE status IN ('sent', 'partial')), 0) AS open_total,
              count(*) FILTER (WHERE status IN ('sent', 'partial')
                                 AND expected_date < $2)::int AS overdue_n,
              COALESCE(sum(to_come) FILTER (WHERE status IN ('sent', 'partial')
                                              AND expected_date < $2), 0) AS overdue_total,
              to_char(min(expected_date) FILTER (WHERE status IN ('sent', 'partial')
                                                   AND expected_date < $2), 'YYYY-MM-DD') AS oldest,
              count(*) FILTER (WHERE grni > 0.005)::int AS rnb_n,
              COALESCE(sum(grni), 0) AS rnb_total
         FROM po`,
      [companyId, today],
    );
    return {
      open: { count: num(r?.open_n), total: r2(num(r?.open_total)) },
      overdue: {
        count: num(r?.overdue_n),
        total: r2(num(r?.overdue_total)),
        oldest: (r?.oldest as string | null) ?? null,
      },
      receivedNotBilled: {
        count: num(r?.rnb_n),
        total: r2(num(r?.rnb_total)),
      },
    };
  }

  private async topCustomers(
    companyId: string,
    day: DateFilter,
    creatorId: string | null,
  ) {
    const p = new Params();
    const company = p.add(companyId);
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT d.party_id, d.party_name,
              count(*)::int AS n, COALESCE(sum(d.amount), 0) AS total
         FROM (${this.docs(['invoice'], p, company, day)}) d
        WHERE d.counted ${this.creatorClause(p, creatorId)}
        GROUP BY d.party_id, d.party_name
        ORDER BY total DESC, n DESC
        LIMIT 5`,
      p.values,
    );
    return rows.map((r) => ({
      id: String(r.party_id),
      name: (r.party_name as string) || 'Unnamed customer',
      count: num(r.n),
      total: r2(num(r.total)),
    }));
  }

  // ── Item-wise sales ──────────────────────────────────────────────────────

  /**
   * The item-wise sales sheet for one day or a range: per item (and per
   * service or charge) the units sold, given free and returned, net units and
   * net sales; for an owner also cost, profit and margin. With `compare`, each
   * line carries its net sales in the comparison period too. Staff see the
   * documents they prepared, exactly as in the rest of the Day Summary.
   */
  async items(
    companyId: string,
    viewer: DaySummaryViewer,
    opts: {
      from?: string;
      to?: string;
      createdBy?: string | null;
      compare?: DayItemCompare | null;
    } = {},
  ): Promise<DayItemSheet> {
    const ctx = await this.context(companyId);
    const today = businessToday(ctx.timezone);
    const from = opts.from || today;
    const to = opts.to || from;
    const scope = await this.scope(companyId, viewer, opts.createdBy);
    const creatorId = scope.creator?.id ?? null;
    const showCost = !scope.ownOnly;
    const period: DateFilter = { mode: 'dated', from, to };
    const compare = opts.compare ?? null;
    const before = compare ? comparePeriod(from, to, compare) : null;

    const [current, previous, tie] = await Promise.all([
      this.itemFigures(companyId, ctx.kinds, period, creatorId),
      before
        ? this.itemFigures(
            companyId,
            ctx.kinds,
            { mode: 'dated', ...before },
            creatorId,
          )
        : null,
      this.salesTie(companyId, ctx.kinds, period, creatorId),
    ]);
    const sheet = buildItemSheet(current, previous, showCost);
    const moved = sheet.rows
      .filter((r) => r.itemId && (r.sold > 0 || r.free > 0))
      .map((r) => r.itemId!);
    const netSales = r2(tie.sales - tie.returns);

    return {
      from,
      to,
      today,
      currency: ctx.currency,
      scope: { ownOnly: scope.ownOnly, createdBy: scope.creator },
      compare,
      compareFrom: before?.from ?? null,
      compareTo: before?.to ?? null,
      ...sheet,
      showCost,
      reconciliation: {
        salesBeforeTax: r2(tie.sales),
        returns: r2(tie.returns),
        netSales,
        matches: Math.abs(netSales - sheet.totals.value) < 0.05,
      },
      reorder: ctx.inventory ? await this.reorder(companyId, moved) : null,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * Per item, and per service or charge, for the period: units sold, given
   * free and returned, net sales and cost.
   *
   * The arithmetic is the item reports' (`ReportsService.itemSalesLinesSql`):
   * a line's value is before tax and keeps only its share of the invoice's
   * discount, returns are credit memo lines, and goods sold through the
   * delivery flow come from what was delivered — the invoice a delivery
   * raises carries the same goods as item-less lines, so those lines are left
   * out rather than counted twice. The documents are the Day Summary's own
   * (`docs`), so drafts, voids, migrated history, staff scope and approval
   * crediting are exactly as on the rest of the page.
   *
   * A line at price 0 is a free unit (FinMatrix's free goods and samples).
   */
  private async itemFigures(
    companyId: string,
    kinds: DayDocKind[],
    f: DateFilter,
    creatorId: string | null,
  ): Promise<ItemFigures[]> {
    const docKinds = (['invoice', 'credit_memo'] as const).filter((k) =>
      kinds.includes(k),
    );
    const p = new Params();
    const company = p.add(companyId);
    const docs = this.docs(docKinds, p, company, f);
    const creator = this.creatorClause(p, creatorId);
    // The share of an invoice's pre-tax amount that survives its discount.
    const kept = `(CASE WHEN i.subtotal::numeric > 0
                        THEN 1 - COALESCE(i.discount_amount, 0)::numeric / i.subtotal::numeric
                        ELSE 1 END)`;
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `WITH d AS (
         SELECT d.kind, d.id FROM (${docs}) d WHERE d.counted ${creator}
       ),
       inv AS (
         SELECT i.id, i.subtotal, i.discount_amount,
                EXISTS (SELECT 1 FROM deliveries dl
                         WHERE dl.company_id = ${company} AND dl.invoice_id = i.id
                           AND dl.ledger_status = 'committed') AS from_delivery
           FROM d JOIN invoices i ON d.kind = 'invoice' AND i.id = d.id
       ),
       lines AS (
         SELECT li.item_id, btrim(li.description) AS label,
                li.quantity::numeric AS qty,
                (li.unit_price::numeric = 0) AS free,
                false AS returned,
                ((li.line_total - COALESCE(li.tax_amount, 0)) * ${kept})::numeric AS value,
                COALESCE(li.cost_amount, 0)::numeric AS cost,
                (li.item_id IS NOT NULL AND li.cost_amount IS NULL) AS cost_missing
           FROM inv i JOIN invoice_line_items li ON li.invoice_id = i.id
          WHERE li.item_id IS NOT NULL OR NOT i.from_delivery
         UNION ALL
         SELECT di.item_id, btrim(di.item_name), di.delivered_qty::numeric,
                (di.unit_price::numeric = 0), false,
                (di.delivered_qty * di.unit_price * ${kept})::numeric,
                (di.delivered_qty * COALESCE(di.unit_cost, 0))::numeric,
                (di.unit_cost IS NULL)
           FROM inv i
           -- The company first: deliveries.invoice_id has no index of its own.
           JOIN deliveries dl ON dl.company_id = ${company} AND dl.invoice_id = i.id
                             AND dl.ledger_status = 'committed'
           JOIN delivery_items di ON di.delivery_id = dl.id
          WHERE di.delivered_qty > 0
         UNION ALL
         SELECT cml.item_id, btrim(cml.description), cml.quantity::numeric,
                (cml.unit_price::numeric = 0), true,
                -(cml.quantity * cml.unit_price)::numeric,
                -(cml.quantity * COALESCE(cml.restock_unit_cost, 0))::numeric,
                (cml.item_id IS NOT NULL AND cml.restock_unit_cost IS NULL)
           FROM d JOIN credit_memo_lines cml
             ON d.kind = 'credit_memo' AND cml.credit_memo_id = d.id
       ),
       agg AS (
         SELECT l.item_id,
                (CASE WHEN l.item_id IS NULL
                      THEN lower(regexp_replace(COALESCE(l.label, ''), '\\s+', ' ', 'g'))
                 END) AS service_key,
                max(l.label) AS label,
                COALESCE(sum(l.qty) FILTER (WHERE NOT l.returned AND NOT l.free), 0) AS sold,
                COALESCE(sum(l.qty) FILTER (WHERE NOT l.returned AND l.free), 0) AS free,
                COALESCE(sum(l.qty) FILTER (WHERE l.returned), 0) AS returned,
                COALESCE(sum(l.value), 0) AS value,
                COALESCE(-sum(l.value) FILTER (WHERE l.returned), 0) AS returns_value,
                COALESCE(sum(l.cost), 0) AS cost,
                bool_or(l.cost_missing) AS cost_missing
           FROM lines l
          GROUP BY 1, 2
       )
       SELECT agg.*, it.sku, it.name AS item_name, it.unit_of_measure,
              NULLIF(btrim(it.category), '') AS category, ag.name AS agency
         FROM agg
         LEFT JOIN inventory_items it ON it.id = agg.item_id
         LEFT JOIN agencies ag ON ag.id = it.source_agency_id`,
      p.values,
    );
    return rows.map((r) => {
      const itemId = (r.item_id as string | null) ?? null;
      return {
        kind: itemId ? ('item' as const) : ('service' as const),
        itemId,
        serviceKey: itemId ? null : String(r.service_key ?? ''),
        name:
          (r.item_name as string) ||
          (r.label as string) ||
          (itemId ? 'Item' : 'Other charges'),
        code: (r.sku as string | null) ?? null,
        unit: (r.unit_of_measure as string | null) ?? null,
        category: (r.category as string | null) ?? null,
        agency: (r.agency as string | null) ?? null,
        sold: num(r.sold),
        free: num(r.free),
        returned: num(r.returned),
        value: num(r.value),
        returnsValue: num(r.returns_value),
        cost: num(r.cost),
        costMissing: r.cost_missing === true,
      };
    });
  }

  /**
   * What the period's documents say net sales are, for the sheet to tie to:
   * invoices before tax and after their discounts, less returns before tax.
   */
  private async salesTie(
    companyId: string,
    kinds: DayDocKind[],
    f: DateFilter,
    creatorId: string | null,
  ): Promise<{ sales: number; returns: number }> {
    const docKinds = (['invoice', 'credit_memo'] as const).filter((k) =>
      kinds.includes(k),
    );
    const p = new Params();
    const company = p.add(companyId);
    const [r] = await this.dataSource.query(
      `SELECT COALESCE(sum(i.subtotal - COALESCE(i.discount_amount, 0)), 0) AS sales,
              COALESCE(sum(cm.subtotal), 0) AS returns
         FROM (${this.docs(docKinds, p, company, f)}) d
         LEFT JOIN invoices i ON d.kind = 'invoice' AND i.id = d.id
         LEFT JOIN credit_memos cm ON d.kind = 'credit_memo' AND cm.id = d.id
        WHERE d.counted ${this.creatorClause(p, creatorId)}`,
      p.values,
    );
    return { sales: num(r?.sales), returns: num(r?.returns) };
  }

  /**
   * Of the items that left the shelves in the period, those that now need
   * reordering: out of stock, or at or below their reorder point. Stock is as
   * it stands now, which is what a reorder decision is made on.
   */
  private async reorder(
    companyId: string,
    itemIds: string[],
  ): Promise<DayReorderRow[]> {
    if (itemIds.length === 0) return [];
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT it.id, it.sku, it.name, it.unit_of_measure,
              it.quantity_on_hand, it.reorder_point, it.reorder_quantity
         FROM inventory_items it
        WHERE it.company_id = $1 AND it.id = ANY($2::uuid[]) AND it.is_active
          AND (it.quantity_on_hand <= 0
               OR (it.reorder_point > 0 AND it.quantity_on_hand <= it.reorder_point))
        ORDER BY (it.quantity_on_hand <= 0) DESC,
                 it.quantity_on_hand - it.reorder_point, it.name
        LIMIT 100`,
      [companyId, itemIds],
    );
    return rows.map((r) => ({
      itemId: String(r.id),
      code: String(r.sku ?? ''),
      name: String(r.name ?? 'Item'),
      unit: (r.unit_of_measure as string | null) ?? null,
      onHand: r2(num(r.quantity_on_hand)),
      reorderPoint: r2(num(r.reorder_point)),
      reorderQuantity: r2(num(r.reorder_quantity)),
      outOfStock: num(r.quantity_on_hand) <= 0,
    }));
  }

  /**
   * Sales and receipts by the local hour they were entered. The documents are
   * the day's (dated that day), so the hours add up to the headline figures.
   */
  private async hourly(
    companyId: string,
    kinds: DayDocKind[],
    day: DateFilter,
    timeZone: string,
    creatorId: string | null,
  ): Promise<DayHourRow[]> {
    const p = new Params();
    const company = p.add(companyId);
    const wanted = kinds.filter((k) => k === 'invoice' || k === 'receipt');
    const docs = this.docs(wanted, p, company, day);
    const tz = p.add(timeZone);
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT extract(hour FROM (d.created_at AT TIME ZONE ${tz}))::int AS hour,
              d.kind, count(*)::int AS n, COALESCE(sum(d.amount), 0) AS total
         FROM (${docs}) d
        WHERE d.counted ${this.creatorClause(p, creatorId)}
        GROUP BY 1, 2`,
      p.values,
    );
    const hours: DayHourRow[] = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      sales: 0,
      salesCount: 0,
      received: 0,
      receivedCount: 0,
    }));
    for (const r of rows) {
      const h = hours[num(r.hour)];
      if (!h) continue;
      if (r.kind === 'invoice') {
        h.sales = r2(num(r.total));
        h.salesCount = num(r.n);
      } else {
        h.received = r2(num(r.total));
        h.receivedCount = num(r.n);
      }
    }
    return hours;
  }

  /** Money in (receipts) and out (vendor payments) per payment method. */
  private async cash(
    companyId: string,
    day: DateFilter,
    creatorId: string | null,
  ) {
    const p = new Params();
    const company = p.add(companyId);
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT d.kind, COALESCE(NULLIF(d.method, ''), 'other') AS method,
              COALESCE(sum(d.amount), 0) AS total
         FROM (${this.docs(['receipt', 'vendor_payment'], p, company, day)}) d
        WHERE d.counted ${this.creatorClause(p, creatorId)}
        GROUP BY d.kind, 2`,
      p.values,
    );
    const order = ['cash', 'bank_transfer', 'check', 'credit_card', 'other'];
    const byMethod = new Map<string, { received: number; paid: number }>();
    for (const r of rows) {
      const m = String(r.method);
      const cur = byMethod.get(m) ?? { received: 0, paid: 0 };
      if (r.kind === 'receipt') cur.received += num(r.total);
      else cur.paid += num(r.total);
      byMethod.set(m, cur);
    }
    const rank = (m: string) => {
      const i = order.indexOf(m);
      return i === -1 ? order.length : i;
    };
    return {
      methods: [...byMethod.entries()]
        .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
        .map(([method, v]) => ({
          method,
          received: r2(v.received),
          paid: r2(v.paid),
        })),
    };
  }

  /** The day's posted invoices, broken down, and the returns against them. */
  private async invoiceBreakdown(
    companyId: string,
    kinds: DayDocKind[],
    day: DateFilter,
    creatorId: string | null,
  ) {
    const docKinds = (['invoice', 'credit_memo'] as const).filter((k) =>
      kinds.includes(k),
    );
    const p = new Params();
    const company = p.add(companyId);
    const [r] = await this.dataSource.query(
      `SELECT COALESCE(sum(i.subtotal), 0) AS subtotal,
              COALESCE(sum(i.discount_amount), 0) AS discount,
              COALESCE(sum(i.tax_amount), 0) AS tax,
              COALESCE(sum(i.total), 0) AS total,
              COALESCE(sum(i.balance), 0) AS unpaid,
              COALESCE(sum(cm.total), 0) AS returns
         FROM (${this.docs(docKinds, p, company, day)}) d
         LEFT JOIN invoices i ON d.kind = 'invoice' AND i.id = d.id
         LEFT JOIN credit_memos cm ON d.kind = 'credit_memo' AND cm.id = d.id
        WHERE d.counted ${this.creatorClause(p, creatorId)}`,
      p.values,
    );
    const total = r2(num(r?.total));
    const returns = r2(num(r?.returns));
    return {
      subtotal: r2(num(r?.subtotal)),
      discount: r2(num(r?.discount)),
      tax: r2(num(r?.tax)),
      total,
      unpaid: r2(num(r?.unpaid)),
      returns,
      net: r2(total - returns),
    };
  }

  /**
   * Voids and deletions recorded on the day. Receipts and bills are deleted
   * outright, so the audit trail is the only place they still exist.
   */
  private voidedSql(
    p: Params,
    company: string,
    bounds: { start: Date; end: Date },
    userId: string | null,
  ): string {
    const v = `COALESCE(t.before_values, t.after_values)`;
    const amount = `COALESCE(${v}->>'total', ${v}->>'amount', ${v}->>'totalAmount')`;
    return `
      SELECT t.resource_type, t.resource_id, t.action, t.created_at,
             t.user_id, u.display_name,
             COALESCE(${v}->>'invoiceNumber', ${v}->>'billNumber',
                      ${v}->>'paymentNumber', ${v}->>'creditMemoNumber',
                      ${v}->>'vendorCreditNumber', ${v}->>'reference') AS number,
             COALESCE(${v}->>'invoiceDate', ${v}->>'billDate',
                      ${v}->>'paymentDate', ${v}->>'date') AS doc_date,
             CASE WHEN ${amount} ~ '^-?[0-9]+(\\.[0-9]+)?$'
                  THEN (${amount})::numeric ELSE 0 END AS amount,
             COALESCE(${v}->>'customerId', ${v}->>'vendorId') AS party_id,
             COALESCE(c.name, vd.company_name) AS party_name
        FROM audit_trail t
        LEFT JOIN users u ON u.id = t.user_id
        LEFT JOIN customers c
          ON c.id = CASE WHEN ${v}->>'customerId' ~* '^[0-9a-f-]{36}$'
                         THEN (${v}->>'customerId')::uuid END
        LEFT JOIN vendors vd
          ON vd.id = CASE WHEN ${v}->>'vendorId' ~* '^[0-9a-f-]{36}$'
                          THEN (${v}->>'vendorId')::uuid END
       WHERE t.company_id = ${company}
         AND t.action IN ('void', 'delete')
         AND t.resource_type IN (${Object.keys(AUDIT_KINDS)
           .map((k) => `'${k}'`)
           .join(', ')})
         AND t.created_at >= ${p.add(bounds.start)}
         AND t.created_at < ${p.add(bounds.end)}
         ${userId ? `AND t.user_id = ${p.add(userId)}` : ''}`;
  }

  private async voidedFigure(
    companyId: string,
    bounds: { start: Date; end: Date },
    userId: string | null,
  ): Promise<DayFigure> {
    const p = new Params();
    const company = p.add(companyId);
    const [r] = await this.dataSource.query(
      `SELECT count(*)::int AS n, COALESCE(sum(v.amount), 0) AS total
         FROM (${this.voidedSql(p, company, bounds, userId)}) v`,
      p.values,
    );
    return { count: num(r?.n), total: r2(num(r?.total)) };
  }

  private async members(companyId: string) {
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT u.id, u.display_name, uc.role
         FROM user_companies uc
         JOIN users u ON u.id = uc.user_id
        WHERE uc.company_id = $1 AND uc.role IN ('admin', 'staff')
        ORDER BY (uc.role = 'admin') DESC, lower(u.display_name)`,
      [companyId],
    );
    return rows.map((r) => ({
      id: String(r.id),
      name: (r.display_name as string) || 'Unnamed',
      role: String(r.role),
    }));
  }

  // ── Day Book ─────────────────────────────────────────────────────────────

  /**
   * One page of the day's documents. Filtered by type or flag, searched by
   * document number or party name, sorted by entry time or amount. The
   * count and the two totals are over every matching row, not the page, so a
   * pager can say "26–50 of 143" and the footer what all 143 come to.
   */
  async entries(
    companyId: string,
    viewer: DaySummaryViewer,
    opts: {
      date?: string;
      filter?: DayEntryFilter;
      createdBy?: string | null;
      page?: number;
      limit?: number;
      q?: string | null;
      sort?: DayEntrySort;
    } = {},
  ): Promise<DayEntriesResponse> {
    const ctx = await this.context(companyId);
    const date = opts.date || businessToday(ctx.timezone);
    const filter: DayEntryFilter = opts.filter ?? 'all';
    const sort: DayEntrySort = opts.sort ?? 'newest';
    const q = (opts.q ?? '').trim() || null;
    const scope = await this.scope(companyId, viewer, opts.createdBy);
    const creatorId = scope.creator?.id ?? null;
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const limit = Math.min(1000, Math.max(1, Math.floor(opts.limit ?? 50)));
    const offset = (page - 1) * limit;
    const bounds = localDayBounds(date, ctx.timezone);
    const paging = { date, filter, q, sort, page, limit, offset };

    if (filter === 'voided') {
      // Staff are not shown other people's voids and deletions.
      if (scope.ownOnly) return this.emptyPage(paging);
      return this.voidedEntries(companyId, bounds, creatorId, paging);
    }

    const p = new Params();
    const company = p.add(companyId);
    let kinds: DayDocKind[] = ctx.kinds;
    let extra = '';
    let f: DateFilter = { mode: 'dated', from: date, to: date };
    if (filter === 'backdated') {
      f = {
        mode: 'backdated',
        start: bounds.start,
        end: bounds.end,
        before: date,
      };
    } else if (filter === 'drafts') {
      kinds = kinds.filter((k) => DRAFT_KINDS.includes(k));
      extra = `AND d.status = 'draft'`;
    } else if (filter === 'cancelled') {
      kinds = kinds.filter(
        (k) => k === 'sales_order' || k === 'purchase_order',
      );
      extra = `AND ${CALLED_OFF_SQL}`;
    } else if (filter !== 'all') {
      kinds = kinds.filter((k) => k === filter);
    }

    const docs = this.docs(kinds, p, company, f);
    const where = `WHERE true ${extra} ${this.creatorClause(p, creatorId)}
                   ${this.searchClause(p, q, 'd.number', 'd.party_name')}`;
    const from = `FROM (${docs}) d`;
    // The totals bind exactly the filter's parameters. Anything only the page
    // query reads (the zone, the limit, the offset) is added after this copy:
    // Postgres refuses a statement handed a parameter it never references.
    const baseValues = [...p.values];
    const tz = p.add(ctx.timezone);
    const order = ENTRY_ORDER[sort]('d');
    const [rows, totals] = await Promise.all([
      this.dataSource.query(
        `SELECT d.*, u.display_name AS creator_name,
                ((d.created_at AT TIME ZONE ${tz})::date > d.doc_date::date) AS backdated
           ${from}
           LEFT JOIN users u ON u.id = d.creator_id
          ${where}
          ORDER BY ${order}
          LIMIT ${p.add(limit)} OFFSET ${p.add(offset)}`,
        p.values,
      ) as Promise<Array<Record<string, unknown>>>,
      this.dataSource.query(
        `SELECT count(*)::int AS n,
                COALESCE(sum(d.amount) FILTER (WHERE d.counted), 0) AS counted,
                COALESCE(sum(d.amount) FILTER (WHERE NOT d.counted), 0) AS excluded
           ${from} ${where}`,
        baseValues,
      ) as Promise<Array<Record<string, unknown>>>,
    ]);
    return this.page(
      paging,
      totals[0],
      rows.map(
        (r): DayEntry => ({
          kind: r.kind as DayDocKind,
          id: String(r.id),
          number: (r.number as string | null) ?? null,
          date: String(r.doc_date),
          createdAt: new Date(r.created_at as string).toISOString(),
          partyId: (r.party_id as string | null) ?? null,
          partyName: (r.party_name as string | null) ?? null,
          amount: r2(num(r.amount)),
          status: (r.status as string | null) ?? null,
          createdBy: r.creator_id
            ? {
                id: String(r.creator_id),
                name: (r.creator_name as string) || 'Unnamed',
              }
            : null,
          backdated: Boolean(r.backdated),
          counted: Boolean(r.counted),
          deleted: false,
        }),
      ),
    );
  }

  /**
   * `AND (number ILIKE … OR party ILIKE …)`, or nothing. The search is taken
   * literally: `%` and `_` are escaped, so "50%" finds "50%", not everything.
   */
  private searchClause(
    p: Params,
    q: string | null,
    numberCol: string,
    partyCol: string,
  ): string {
    if (!q) return '';
    const like = p.add(`%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
    return `AND (${numberCol} ILIKE ${like} ESCAPE '\\' OR ${partyCol} ILIKE ${like} ESCAPE '\\')`;
  }

  private page(
    paging: {
      date: string;
      filter: DayEntryFilter;
      q: string | null;
      sort: DayEntrySort;
      page: number;
      limit: number;
    },
    totals: Record<string, unknown> | undefined,
    items: DayEntry[],
  ): DayEntriesResponse {
    const total = num(totals?.n);
    return {
      date: paging.date,
      filter: paging.filter,
      q: paging.q,
      sort: paging.sort,
      items,
      total,
      countedTotal: r2(num(totals?.counted)),
      excludedTotal: r2(num(totals?.excluded)),
      page: paging.page,
      limit: paging.limit,
      pages: Math.ceil(total / paging.limit),
    };
  }

  private emptyPage(paging: {
    date: string;
    filter: DayEntryFilter;
    q: string | null;
    sort: DayEntrySort;
    page: number;
    limit: number;
  }): DayEntriesResponse {
    return this.page(paging, undefined, []);
  }

  private async voidedEntries(
    companyId: string,
    bounds: { start: Date; end: Date },
    userId: string | null,
    paging: {
      date: string;
      filter: DayEntryFilter;
      q: string | null;
      sort: DayEntrySort;
      page: number;
      limit: number;
      offset: number;
    },
  ): Promise<DayEntriesResponse> {
    const p = new Params();
    const company = p.add(companyId);
    const inner = this.voidedSql(p, company, bounds, userId);
    const where = `WHERE true ${this.searchClause(p, paging.q, 'v.number', 'v.party_name')}`;
    const baseValues = [...p.values];
    const [rows, totals] = await Promise.all([
      this.dataSource.query(
        `SELECT v.* FROM (${inner}) v ${where}
          ORDER BY ${ENTRY_ORDER[paging.sort]('v', 'resource_id')}
          LIMIT ${p.add(paging.limit)} OFFSET ${p.add(paging.offset)}`,
        p.values,
      ) as Promise<Array<Record<string, unknown>>>,
      this.dataSource.query(
        `SELECT count(*)::int AS n, 0 AS counted,
                COALESCE(sum(v.amount), 0) AS excluded
           FROM (${inner}) v ${where}`,
        baseValues,
      ) as Promise<Array<Record<string, unknown>>>,
    ]);
    return this.page(
      paging,
      totals[0],
      rows.map(
        (r): DayEntry => ({
          kind: AUDIT_KINDS[String(r.resource_type)] ?? 'invoice',
          id: String(r.resource_id),
          number: (r.number as string | null) ?? null,
          date: r.doc_date ? String(r.doc_date).slice(0, 10) : paging.date,
          createdAt: new Date(r.created_at as string).toISOString(),
          partyId: (r.party_id as string | null) ?? null,
          partyName: (r.party_name as string | null) ?? null,
          amount: r2(num(r.amount)),
          status: r.action === 'delete' ? 'deleted' : 'void',
          createdBy: r.user_id
            ? {
                id: String(r.user_id),
                name: (r.display_name as string) || 'Unnamed',
              }
            : null,
          backdated: false,
          counted: false,
          deleted: r.action === 'delete',
        }),
      ),
    );
  }

  // ── Digest schedule ──────────────────────────────────────────────────────

  async getSchedule(companyId: string): Promise<DaySummarySchedule> {
    const [row] = await this.dataSource.query(
      `SELECT day_summary_enabled, day_summary_hour, day_summary_email,
              to_char(day_summary_last_sent, 'YYYY-MM-DD') AS last_sent, timezone
         FROM company_settings WHERE company_id = $1`,
      [companyId],
    );
    return {
      enabled: Boolean(row?.day_summary_enabled),
      hour: row?.day_summary_hour != null ? Number(row.day_summary_hour) : 21,
      email:
        row?.day_summary_email != null ? Boolean(row.day_summary_email) : true,
      timezone: businessTimezone(row?.timezone),
      lastSent: row?.last_sent ?? null,
    };
  }

  async setSchedule(
    companyId: string,
    patch: { enabled?: boolean; hour?: number; email?: boolean },
  ): Promise<DaySummarySchedule> {
    const cur = await this.getSchedule(companyId);
    const next = {
      enabled: patch.enabled ?? cur.enabled,
      hour: patch.hour ?? cur.hour,
      email: patch.email ?? cur.email,
    };
    await this.dataSource.query(
      `INSERT INTO company_settings
              (company_id, day_summary_enabled, day_summary_hour, day_summary_email)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (company_id) DO UPDATE
          SET day_summary_enabled = EXCLUDED.day_summary_enabled,
              day_summary_hour = EXCLUDED.day_summary_hour,
              day_summary_email = EXCLUDED.day_summary_email,
              updated_at = now()`,
      [companyId, next.enabled, next.hour, next.email],
    );
    return this.getSchedule(companyId);
  }
}
