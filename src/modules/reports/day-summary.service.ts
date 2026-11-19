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
  DayFigure,
  DayHourRow,
  DayKpi,
  DaySummaryResponse,
  DaySummarySchedule,
  DayUserRow,
} from './day-summary.types';
import {
  buildKpi,
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
 * Invoices, sales orders and estimates record their creator. Receipts, bills
 * and vendor payments do not, so the person comes from the journal entry the
 * document posted. Purchase orders post nothing and record no creator.
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
    status: 'x.status',
    method: 'NULL',
    partyCol: 'vendor_id',
    partyTable: 'vendors',
    partyName: 'p.company_name',
    creator: 'NULL::uuid',
    joinJournal: false,
    counted: 'true',
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

/** audit_trail resource types → the Day Book kind they are shown as. */
const AUDIT_KINDS: Record<string, DayDocKind> = {
  invoice: 'invoice',
  payment: 'receipt',
  bill: 'bill',
  bill_payment: 'vendor_payment',
  credit_memo: 'credit_memo',
  vendor_credit: 'vendor_credit',
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

    const [
      series,
      backdated,
      team,
      topCustomers,
      topItems,
      cash,
      sales,
      voided,
      profit,
      members,
      hourly,
    ] = await Promise.all([
      this.series(companyId, ctx.kinds, date, w.from, creatorId),
      this.backdatedCount(companyId, ctx.kinds, date, bounds, creatorId),
      everyone ? this.team(companyId, ctx.kinds, day) : null,
      this.topCustomers(companyId, day, creatorId),
      this.topItems(companyId, day, creatorId),
      this.cash(companyId, day, creatorId),
      this.invoiceBreakdown(companyId, day, creatorId),
      owner ? this.voidedFigure(companyId, bounds, creatorId) : null,
      everyone ? this.reports.profitLoss(companyId, date, date) : null,
      owner ? this.members(companyId) : null,
      this.hourly(companyId, ctx.kinds, day, ctx.timezone, creatorId),
    ]);

    const kpi = (k: DayDocKind): DayKpi =>
      buildKpi(series.byKind.get(k) ?? new Map(), date);
    const figureOn = (k: DayDocKind): DayFigure => {
      const f = series.byKind.get(k)?.get(date);
      return { count: f?.count ?? 0, total: r2(f?.total ?? 0) };
    };

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
      },
      trendDates: w.trendDates,
      documents: ctx.kinds.map((kind) => ({ kind, ...figureOn(kind) })),
      sales,
      cash: { methods, received, paid, net: r2(received - paid) },
      topCustomers,
      topItems,
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
      isEmpty:
        series.rowsOnDate === 0 &&
        backdated === 0 &&
        (voided?.count ?? 0) === 0,
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
                                 AND d.kind IN ('invoice', 'bill'))::int AS drafts,
              count(*) FILTER (WHERE d.status = 'cancelled'
                                 AND d.kind = 'sales_order')::int AS cancelled
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
    }
    return [...people.values()].sort(
      (a, b) =>
        // People before the "not recorded" bucket, busiest first.
        Number(a.userId === null) - Number(b.userId === null) ||
        b.documents - a.documents ||
        b.invoices.total - a.invoices.total,
    );
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

  /**
   * Best sellers by pre-tax value after the invoice's discount — the basis the
   * item reports use. A line with no stock item is grouped by its wording.
   */
  private async topItems(
    companyId: string,
    day: DateFilter,
    creatorId: string | null,
  ) {
    const p = new Params();
    const company = p.add(companyId);
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT li.item_id,
              COALESCE(max(it.name), max(btrim(li.description)), 'Item') AS name,
              COALESCE(sum(li.quantity), 0) AS qty,
              COALESCE(sum(
                (li.line_total - COALESCE(li.tax_amount, 0)) *
                (CASE WHEN i.subtotal::numeric > 0
                      THEN 1 - COALESCE(i.discount_amount, 0)::numeric / i.subtotal::numeric
                      ELSE 1 END)
              ), 0) AS total
         FROM (${this.docs(['invoice'], p, company, day)}) d
         JOIN invoices i ON i.id = d.id
         JOIN invoice_line_items li ON li.invoice_id = d.id
         LEFT JOIN inventory_items it ON it.id = li.item_id
        WHERE d.counted ${this.creatorClause(p, creatorId)}
        GROUP BY li.item_id,
                 (CASE WHEN li.item_id IS NULL THEN lower(btrim(li.description)) END)
        ORDER BY total DESC
        LIMIT 5`,
      p.values,
    );
    return rows.map((r) => ({
      itemId: (r.item_id as string | null) ?? null,
      name: String(r.name),
      quantity: r2(num(r.qty)),
      total: r2(num(r.total)),
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

  private async invoiceBreakdown(
    companyId: string,
    day: DateFilter,
    creatorId: string | null,
  ) {
    const p = new Params();
    const company = p.add(companyId);
    const [r] = await this.dataSource.query(
      `SELECT COALESCE(sum(i.subtotal), 0) AS subtotal,
              COALESCE(sum(i.discount_amount), 0) AS discount,
              COALESCE(sum(i.tax_amount), 0) AS tax,
              COALESCE(sum(i.total), 0) AS total,
              COALESCE(sum(i.balance), 0) AS unpaid
         FROM (${this.docs(['invoice'], p, company, day)}) d
         JOIN invoices i ON i.id = d.id
        WHERE d.counted ${this.creatorClause(p, creatorId)}`,
      p.values,
    );
    return {
      subtotal: r2(num(r?.subtotal)),
      discount: r2(num(r?.discount)),
      tax: r2(num(r?.tax)),
      total: r2(num(r?.total)),
      unpaid: r2(num(r?.unpaid)),
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

  async entries(
    companyId: string,
    viewer: DaySummaryViewer,
    opts: {
      date?: string;
      filter?: DayEntryFilter;
      createdBy?: string | null;
      page?: number;
      limit?: number;
    } = {},
  ): Promise<DayEntriesResponse> {
    const ctx = await this.context(companyId);
    const date = opts.date || businessToday(ctx.timezone);
    const filter: DayEntryFilter = opts.filter ?? 'all';
    const scope = await this.scope(companyId, viewer, opts.createdBy);
    const creatorId = scope.creator?.id ?? null;
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const limit = Math.min(1000, Math.max(1, Math.floor(opts.limit ?? 50)));
    const offset = (page - 1) * limit;
    const bounds = localDayBounds(date, ctx.timezone);

    if (filter === 'voided') {
      // Staff are not shown other people's voids and deletions.
      if (scope.ownOnly) {
        return { date, filter, items: [], total: 0, page, limit };
      }
      return this.voidedEntries(companyId, date, bounds, creatorId, {
        page,
        limit,
        offset,
      });
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
      kinds = kinds.filter((k) => k === 'invoice' || k === 'bill');
      extra = `AND d.status = 'draft'`;
    } else if (filter === 'cancelled') {
      kinds = kinds.filter((k) => k === 'sales_order');
      extra = `AND d.status = 'cancelled'`;
    } else if (filter !== 'all') {
      kinds = kinds.filter((k) => k === filter);
    }

    const docs = this.docs(kinds, p, company, f);
    const tz = p.add(ctx.timezone);
    const creator = this.creatorClause(p, creatorId);
    const lim = p.add(limit);
    const off = p.add(offset);
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT d.*, u.display_name AS creator_name,
              ((d.created_at AT TIME ZONE ${tz})::date > d.doc_date::date) AS backdated,
              count(*) OVER () AS total_count
         FROM (${docs}) d
         LEFT JOIN users u ON u.id = d.creator_id
        WHERE true ${extra} ${creator}
        ORDER BY d.created_at DESC, d.id
        LIMIT ${lim} OFFSET ${off}`,
      p.values,
    );
    return {
      date,
      filter,
      items: rows.map(
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
      total: num(rows[0]?.total_count),
      page,
      limit,
    };
  }

  private async voidedEntries(
    companyId: string,
    date: string,
    bounds: { start: Date; end: Date },
    userId: string | null,
    paging: { page: number; limit: number; offset: number },
  ): Promise<DayEntriesResponse> {
    const p = new Params();
    const company = p.add(companyId);
    const inner = this.voidedSql(p, company, bounds, userId);
    const rows: Array<Record<string, unknown>> = await this.dataSource.query(
      `SELECT v.*, count(*) OVER () AS total_count FROM (${inner}) v
        ORDER BY v.created_at DESC
        LIMIT ${p.add(paging.limit)} OFFSET ${p.add(paging.offset)}`,
      p.values,
    );
    return {
      date,
      filter: 'voided',
      items: rows.map(
        (r): DayEntry => ({
          kind: AUDIT_KINDS[String(r.resource_type)] ?? 'invoice',
          id: String(r.resource_id),
          number: (r.number as string | null) ?? null,
          date: r.doc_date ? String(r.doc_date).slice(0, 10) : date,
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
      total: num(rows[0]?.total_count),
      page: paging.page,
      limit: paging.limit,
    };
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
