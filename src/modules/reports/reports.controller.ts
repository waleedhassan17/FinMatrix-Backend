import {
  BadRequestException,
  Controller,
  Logger,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Response } from 'express';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import {
  REPORT_RANGE_DEFAULTS,
  ReportsService,
  reportToday,
} from './reports.service';
import { ReportsKpiService } from './reports-kpi.service';
import { AgingQueryDto, UnifiedAgingQueryDto } from './dto/aging-query.dto';
import { AgingDetailQueryDto } from './dto/aging-detail-query.dto';

/**
 * The top-level keys each @Res() report returned before v2, in their original
 * order. The CSV export is built from exactly these (see `send`), so adding a
 * field to the JSON never adds a column to a spreadsheet.
 */
const LEGACY_KEYS = {
  balanceSheet: [
    'asOfDate', 'assets', 'liabilities', 'equity',
    'totalAssets', 'totalLiabilities', 'totalEquity', 'isBalanced',
  ],
  cashFlow: [
    'range', 'operating', 'investing', 'financing', 'netChange',
    'beginningCash', 'endingCash', 'monthlyTrend', 'operatingIndirect',
  ],
  trialBalance: ['range', 'rows', 'totalDebits', 'totalCredits', 'isBalanced'],
  aging: ['asOfDate', 'preset', 'buckets', 'rows', 'totals'],
  inventoryValuation: ['rows', 'byCategory', 'totalValue'],
} as const;

/** A real calendar date in `YYYY-MM-DD` form — not merely the right shape. */
const isIsoDate = (v: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const [y, m, d] = v.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
};

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@Controller('reports')
export class ReportsController {
  private readonly logger = new Logger(ReportsController.name);

  constructor(
    private readonly svc: ReportsService,
    private readonly kpi: ReportsKpiService,
  ) {}

  /**
   * Resolve a report range at the edge.
   *
   * The service already defaults these, and this repeats it on purpose. A
   * dated report that receives no range filters general_ledger on a NULL
   * bound, which matches nothing and returns a fully-formed statement of
   * zeroes — a blank P&L with a 200 and no error to explain it. That failure
   * is silent, so it is worth being unable to reach from two directions
   * rather than one. Sharing REPORT_RANGE_DEFAULTS keeps the two in step;
   * they are not two independent policies.
   */
  private range(startDate?: string, endDate?: string) {
    return {
      s: startDate || REPORT_RANGE_DEFAULTS.startDate,
      e: endDate || REPORT_RANGE_DEFAULTS.endDate,
    };
  }

  /**
   * `range`, for the routes that refuse a malformed date rather than pass it
   * to Postgres — where `2026-13-01` is a 500 with a driver message, not an
   * answer. Absent dates still default to all-time, as `range` does.
   */
  private checkedRange(
    startDate?: string,
    endDate?: string,
    strictOrder = true,
  ) {
    for (const [name, v] of [
      ['startDate', startDate],
      ['endDate', endDate],
    ] as const) {
      if (v && !isIsoDate(v)) {
        throw new BadRequestException({
          code: 'INVALID_DATE',
          message: `${name} must be a real date in YYYY-MM-DD form.`,
        });
      }
    }
    const r = this.range(startDate, endDate);
    if (strictOrder && r.s > r.e) {
      throw new BadRequestException({
        code: 'INVALID_RANGE',
        message: 'startDate must not be after endDate.',
      });
    }
    return r;
  }

  @Get('profit-loss')
  @Roles('admin', 'staff')
  async profitLoss(
    @CurrentCompany() companyId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('format') format = 'json',
    @Res() res: Response,
  ) {
    const { s, e } = this.range(startDate, endDate);
    const data = await this.svc.profitLoss(companyId, s, e);
    return this.send(data, format, res, 'profit-loss');
  }

  /**
   * The transactions behind one statement line.
   *
   * Registered BEFORE the other `profit-loss` routes is not required — the
   * segment is literal — but it is kept adjacent to profit-loss on purpose:
   * this is that report's drill-down, not a general ledger view.
   *
   * No `@Res()`, so unlike its neighbours this one goes through
   * ResponseEnvelopeInterceptor and returns `{ success, data }`. That is the
   * shape the newer endpoints use; `send()` exists for the CSV export, which a
   * paginated drill-down has no use for.
   */
  @Get('profit-loss/lines/:accountCode/entries')
  @Roles('admin', 'staff')
  async profitLossLineEntries(
    @CurrentCompany() companyId: string,
    @Param('accountCode') accountCode: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 50,
  ) {
    const { s, e } = this.range(startDate, endDate);
    return this.svc.statementLineEntries(companyId, accountCode, s, e, page, limit);
  }

  /**
   * `compareTo` (optional, v2) adds the prior figures, change and change % to
   * every line in `sections`. It must be a real date BEFORE asOfDate: a
   * comparison against the same day or a later one is a mistake to report,
   * not a statement to draw.
   */
  @Get('balance-sheet')
  @Roles('admin', 'staff')
  @ApiQuery({ name: 'asOfDate', required: false, description: 'YYYY-MM-DD; default today' })
  @ApiQuery({ name: 'compareTo', required: false, description: 'v2 — YYYY-MM-DD, before asOfDate' })
  @ApiQuery({ name: 'includeZero', required: false, description: "v2 — 'true' lists active accounts with no balance in `sections`" })
  async balanceSheet(
    @CurrentCompany() companyId: string,
    @Query('asOfDate') asOfDate: string,
    @Query('format') format = 'json',
    @Res() res: Response,
    @Query('compareTo') compareTo?: string,
    @Query('includeZero') includeZero?: string,
  ) {
    const asOf = asOfDate || reportToday();
    if (compareTo) {
      this.checkedDate('asOfDate', asOf);
      this.checkedDate('compareTo', compareTo);
      if (compareTo >= asOf) {
        throw new BadRequestException({
          code: 'INVALID_COMPARE_DATE',
          message: 'compareTo must be before asOfDate.',
        });
      }
    }
    const data = await this.svc.balanceSheet(companyId, asOf, compareTo, {
      includeZero: includeZero === 'true',
    });
    return this.send(data, format, res, 'balance-sheet', LEGACY_KEYS.balanceSheet);
  }

  /**
   * The balance sheet's Retained Earnings line taken apart, fiscal year by
   * fiscal year. `total` equals that line exactly. Envelope route.
   */
  @Get('balance-sheet/retained-earnings')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Retained earnings by fiscal year (v2)' })
  @ApiQuery({ name: 'asOfDate', required: false, description: 'YYYY-MM-DD; default today' })
  @ApiOkResponse({ description: '{ fiscalYearStart, postedTo3100, byFiscalYear[], total }' })
  async retainedEarnings(
    @CurrentCompany() companyId: string,
    @Query('asOfDate') asOfDate?: string,
  ) {
    return this.svc.retainedEarnings(
      companyId,
      this.checkedDate('asOfDate', asOfDate || reportToday()),
    );
  }

  /**
   * One account's register: every posting with the balance after it, oldest
   * first unless `order=desc`. Envelope route; rows under `entries`.
   */
  @Get('accounts/:accountCode/register')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Account register with running balance (v2)' })
  @ApiParam({ name: 'accountCode', description: 'Account number, e.g. 1000' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false, description: 'max 200' })
  @ApiQuery({ name: 'order', required: false, enum: ['asc', 'desc'] })
  @ApiOkResponse({ description: '{ account, range, openingBalance, periodDebit, periodCredit, closingBalance, entries[], total, page, limit }' })
  async accountRegister(
    @CurrentCompany() companyId: string,
    @Param('accountCode') accountCode: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 50,
    @Query('order') order?: string,
  ) {
    if (order !== undefined && order !== 'asc' && order !== 'desc') {
      throw new BadRequestException({ code: 'INVALID_ORDER', message: "order must be 'asc' or 'desc'." });
    }
    const { s, e } = this.checkedRange(startDate, endDate);
    return this.svc.accountRegister(
      companyId, this.checkedAccountCode(accountCode), s, e, page, limit, order ?? 'asc',
    );
  }

  /**
   * Why an account moved between two periods, by counterparty and by kind of
   * document. With no comparison range, the preceding period of equal length.
   */
  @Get('accounts/:accountCode/movement')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Account movement vs a comparison period (v2)' })
  @ApiParam({ name: 'accountCode' })
  @ApiQuery({ name: 'startDate', required: true })
  @ApiQuery({ name: 'endDate', required: true })
  @ApiQuery({ name: 'compareStartDate', required: false })
  @ApiQuery({ name: 'compareEndDate', required: false })
  @ApiQuery({ name: 'limit', required: false, description: 'counterparties before Other; default 10' })
  @ApiOkResponse({ description: '{ current, prior, change, byCounterparty[], bySourceType[] }' })
  async accountMovement(
    @CurrentCompany() companyId: string,
    @Param('accountCode') accountCode: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('compareStartDate') compareStartDate?: string,
    @Query('compareEndDate') compareEndDate?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 10,
  ) {
    if (!startDate || !endDate) {
      throw new BadRequestException({
        code: 'INVALID_RANGE',
        message: 'startDate and endDate are required.',
      });
    }
    const { s, e } = this.checkedRange(startDate, endDate);
    let cmp: { s?: string; e?: string } = {};
    if (compareStartDate || compareEndDate) {
      if (!compareStartDate || !compareEndDate) {
        throw new BadRequestException({
          code: 'INVALID_RANGE',
          message: 'compareStartDate and compareEndDate go together.',
        });
      }
      cmp = this.checkedRange(compareStartDate, compareEndDate);
    }
    return this.svc.accountMovement(
      companyId, this.checkedAccountCode(accountCode), s, e, cmp.s, cmp.e, limit,
    );
  }

  /**
   * DSO / DPO for the aging insights — best effort.
   *
   * ar-aging and ap-aging are long-standing endpoints that shipped builds
   * read; the KPI is a v2 extra that costs a full financial-health pass. If
   * that pass fails, the aging report must still answer exactly as it always
   * did, so the KPI comes back null and the failure is logged, never a 500.
   */
  private async bestEffortKpi(companyId: string, key: 'dso' | 'dpo', asOf: string) {
    try {
      return await this.kpi.healthKpi(companyId, key, asOf);
    } catch (err) {
      this.logger.warn(`aging insights: ${key} unavailable for ${companyId}: ${(err as Error)?.message}`);
      return null;
    }
  }

  @Get('ar-aging')
  @Roles('admin', 'staff')
  async arAging(
    @CurrentCompany() companyId: string,
    @Query() query: AgingQueryDto,
    @Res() res: Response,
  ) {
    // v2 insights are JSON-only: the CSV export keeps its exact columns.
    const json = (query.format ?? 'json') !== 'csv';
    const data: any = await this.svc.arAging(companyId, query, { withInsights: json });
    if (json && data.insights) {
      data.insights = { dso: await this.bestEffortKpi(companyId, 'dso', data.asOfDate), ...data.insights };
    }
    return this.send(data, query.format ?? 'json', res, 'ar-aging', LEGACY_KEYS.aging);
  }

  @Get('ap-aging')
  @Roles('admin', 'staff')
  async apAging(
    @CurrentCompany() companyId: string,
    @Query() query: AgingQueryDto,
    @Res() res: Response,
  ) {
    const json = (query.format ?? 'json') !== 'csv';
    const data: any = await this.svc.apAging(companyId, query, { withInsights: json });
    if (json && data.insights) {
      data.insights = { dpo: await this.bestEffortKpi(companyId, 'dpo', data.asOfDate), ...data.insights };
    }
    return this.send(data, query.format ?? 'json', res, 'ap-aging', LEGACY_KEYS.aging);
  }

  /**
   * The open invoices behind one customer's A/R aging row.
   *
   * Kept beside its parent report deliberately: this is that report's
   * drill-down, not a general invoice list. Like `profitLossLineEntries` and
   * unlike the aging routes above, there is **no `@Res()`** — this goes through
   * ResponseEnvelopeInterceptor and returns `{ success, data }`. `send()` exists
   * for the CSV export, which a paginated drill-down has no use for.
   *
   * The caller must pass back the `preset`/`buckets` the report is showing, or
   * the server resolves the company default and every bucket label in the
   * detail disagrees with the column that was clicked.
   */
  @Get('ar-aging/customers/:customerId/documents')
  @Roles('admin', 'staff')
  async arAgingCustomerDocuments(
    @CurrentCompany() companyId: string,
    // A malformed id must fail loudly. Unvalidated, it becomes a query that
    // matches nothing, which reads as "this customer owes nothing".
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: AgingDetailQueryDto,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 50,
  ) {
    return this.svc.arAgingPartyDocuments(
      companyId, customerId, query, query.bucket, page, limit,
    );
  }

  /** The open bills behind one vendor's A/P aging row. */
  @Get('ap-aging/vendors/:vendorId/documents')
  @Roles('admin', 'staff')
  async apAgingVendorDocuments(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
    @Query() query: AgingDetailQueryDto,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 50,
  ) {
    return this.svc.apAgingPartyDocuments(
      companyId, vendorId, query, query.bucket, page, limit,
    );
  }

  /**
   * Everything one customer still owes, as of today: every open invoice aged,
   * the aging strip, unapplied receipts and credit memos, and the net due.
   * What the "Outstanding invoices" summary a business sends is built from.
   *
   * Beside the drill-down because it is the same documents — its total is the
   * customer's aging row. Buckets are the company's saved preference, the ones
   * its aging report opens with. Envelope, no `@Res()`, like the drill-down.
   */
  @Get('ar-aging/customers/:customerId/summary')
  @Roles('admin', 'staff')
  async arAgingCustomerSummary(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.svc.arPartySummary(companyId, customerId);
  }

  /** Everything owed to one vendor, as of today — the payables summary. */
  @Get('ap-aging/vendors/:vendorId/summary')
  @Roles('admin', 'staff')
  async apAgingVendorSummary(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
  ) {
    return this.svc.apPartySummary(companyId, vendorId);
  }

  /**
   * `asOfDate` (optional, v2): value stock as of a past date from the dated
   * movement record, with `coverage` and a `ledgerTie` to GL 1200. Absent,
   * the response is today's snapshot exactly as before.
   */
  @Get('inventory-valuation')
  @Roles('admin', 'staff')
  @ApiQuery({ name: 'asOfDate', required: false, description: 'v2 — YYYY-MM-DD' })
  async inventoryValuation(
    @CurrentCompany() companyId: string,
    @Query('format') format = 'json',
    @Res() res: Response,
    @Query('asOfDate') asOfDate?: string,
  ) {
    const data = asOfDate
      ? await this.svc.inventoryValuation(companyId, this.checkedDate('asOfDate', asOfDate))
      : await this.svc.inventoryValuation(companyId);
    return this.send(data, format, res, 'inventory-valuation', LEGACY_KEYS.inventoryValuation);
  }

  /**
   * Stock that needs attention: below reorder point, aging since last in and
   * last out, dead stock, turnover, value by location. Envelope route.
   * Declared after the literal inventory-valuation routes; its own literal
   * path cannot collide with them.
   */
  @Get('inventory-health')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Inventory health (v2)' })
  @ApiQuery({ name: 'asOfDate', required: false, description: 'YYYY-MM-DD; default today' })
  @ApiOkResponse({ description: '{ belowReorder[], aging, deadStock, turnover, dio, byLocation[], totals }' })
  async inventoryHealth(
    @CurrentCompany() companyId: string,
    @Query('asOfDate') asOfDate?: string,
  ) {
    return this.kpi.inventoryHealth(
      companyId,
      asOfDate ? this.checkedDate('asOfDate', asOfDate) : undefined,
    );
  }

  /** Every financial-health KPI as of a date, with formula and inputs. */
  @Get('financial-health')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Financial health KPIs (v2)' })
  @ApiQuery({ name: 'asOfDate', required: false, description: 'YYYY-MM-DD; default today' })
  @ApiOkResponse({ description: '{ asOfDate, kpis: Kpi[] }' })
  async financialHealth(
    @CurrentCompany() companyId: string,
    @Query('asOfDate') asOfDate?: string,
  ) {
    return this.kpi.financialHealth(
      companyId,
      asOfDate ? this.checkedDate('asOfDate', asOfDate) : undefined,
    );
  }

  /**
   * The Owner Cockpit: monthly series, KPIs against the preceding period of
   * equal length, top expenses and customers, budget vs actual, and health.
   * Default range: the fiscal year to date. /analytics-dashboard is untouched.
   */
  @Get('analytics')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Owner cockpit analytics (v2)' })
  @ApiQuery({ name: 'startDate', required: false, description: 'default: start of the fiscal year' })
  @ApiQuery({ name: 'endDate', required: false, description: 'default: today' })
  @ApiQuery({ name: 'expenseTop', required: false, description: 'v2 — expense accounts named before Other (3–10, default 8)' })
  @ApiQuery({ name: 'customerTop', required: false, description: 'v2 — customers named before Other (3–10, default 10)' })
  @ApiOkResponse({ description: '{ range, comparisonRange, series[], kpis[], expenseByAccount[], salesByCustomer, budgetVsActual, health, insights[] }' })
  async analytics(
    @CurrentCompany() companyId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('expenseTop') expenseTop?: string,
    @Query('customerTop') customerTop?: string,
  ) {
    // Read as strings: the global ValidationPipe turns an absent numeric
    // query parameter into NaN before a ParseIntPipe could see it as absent.
    const top = (name: string, v?: string) => {
      if (v === undefined || v === '') return undefined;
      if (!/^\d{1,3}$/.test(v)) {
        throw new BadRequestException({
          code: 'INVALID_TOP',
          message: `${name} must be a whole number.`,
        });
      }
      return Number(v);
    };
    const opts = {
      expenseTop: top('expenseTop', expenseTop),
      customerTop: top('customerTop', customerTop),
    };
    if (startDate || endDate) {
      const end = endDate || reportToday();
      const { s, e } = this.checkedRange(startDate || end, end);
      return this.kpi.analytics(companyId, startDate ? s : undefined, e, opts);
    }
    return this.kpi.analytics(companyId, undefined, undefined, opts);
  }

  /**
   * Company-wide inventory value over time, from GL 1200. Exact, and ties to
   * the balance sheet at every point.
   */
  @Get('inventory-valuation/trend')
  @Roles('admin', 'staff')
  async inventoryValuationTrend(
    @CurrentCompany() companyId: string,
    @Query('months', new ParseIntPipe({ optional: true })) months = 12,
  ) {
    return this.svc.inventoryValuationTrend(companyId, months);
  }

  /**
   * One item's stock level month by month.
   *
   * The `items/:itemId/history` shape keeps the parameter off the segment that
   * follows `inventory-valuation`, so it cannot collide with the literal
   * `trend` route above. Nest matches in declaration order: a route declared
   * as `inventory-valuation/:x` would swallow `trend`, which is why there
   * isn't one.
   */
  @Get('inventory-valuation/items/:itemId/history')
  @Roles('admin', 'staff')
  async inventoryItemHistory(
    @CurrentCompany() companyId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Query('months', new ParseIntPipe({ optional: true })) months = 12,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    // A range, when given, wins over `months` — the item explorer asks for the
    // same window its sales charts cover. `months` alone is what shipped
    // Android builds send, and it keeps meaning what it always did.
    if (startDate && endDate) {
      const { s, e } = this.checkedRange(startDate, endDate);
      return this.svc.inventoryItemHistory(companyId, itemId, months, {
        startDate: s,
        endDate: e,
      });
    }
    return this.svc.inventoryItemHistory(companyId, itemId, months);
  }

  /**
   * One item's sales and gross margin over a period. The payoff for recording
   * cost per line: revenue was always answerable, cost was not.
   */
  @Get('item-performance/:itemId')
  @Roles('admin', 'staff')
  async itemPerformance(
    @CurrentCompany() companyId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
  ) {
    const { s, e } = this.checkedRange(startDate, endDate);
    return this.svc.itemPerformance(companyId, itemId, s, e);
  }

  /**
   * The document lines behind one item's figures — invoices, deliveries and
   * returns — newest first and paginated. A month's entries add up to that
   * month on `item-performance`, because both read the same rows.
   */
  @Get('item-performance/:itemId/entries')
  @Roles('admin', 'staff')
  async itemSalesEntries(
    @CurrentCompany() companyId: string,
    @Param('itemId', ParseUUIDPipe) itemId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 25,
  ) {
    const { s, e } = this.checkedRange(startDate, endDate);
    return this.svc.itemSalesEntries(companyId, itemId, s, e, page, limit);
  }

  /**
   * Every item's sales, cost and margin for a period, beside its stock value.
   *
   * The Inventory Valuation report answers "what is my money sitting in"; this
   * answers "and which of it earns". Declared after the literal
   * `inventory-valuation/*` routes so nothing shadows them.
   */
  @Get('inventory-performance')
  @Roles('admin', 'staff')
  async inventoryPerformance(
    @CurrentCompany() companyId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('sort') sort?: string,
  ) {
    // Format only: an inverted range has always come back empty here, and a
    // shipped client that sends one should keep getting that, not a 400.
    const { s, e } = this.checkedRange(startDate, endDate, false);
    const allowed = ['grossProfit', 'revenue', 'marginPct', 'stockValue'] as const;
    const key = (allowed as readonly string[]).includes(sort ?? '')
      ? (sort as (typeof allowed)[number])
      : 'grossProfit';
    return this.svc.inventoryPerformance(companyId, s, e, key);
  }

  /**
   * `mode` (optional, v2): movement | closing | working. Absent, the response
   * is the period-movement trial balance exactly as it has always been — the
   * server default does not change. `closing` and `working` close as of
   * endDate, which defaults to today for them rather than to the far future.
   */
  @Get('trial-balance')
  @Roles('admin', 'staff')
  @ApiQuery({ name: 'mode', required: false, enum: ['movement', 'closing', 'working'] })
  @ApiQuery({ name: 'includeZero', required: false, description: "v2, with mode — 'true' lists active accounts with nothing in any column" })
  async trialBalance(
    @CurrentCompany() companyId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('format') format = 'json',
    @Res() res: Response,
    @Query('mode') mode?: string,
    @Query('includeZero') includeZero?: string,
  ) {
    if (mode === undefined) {
      const { s, e } = this.range(startDate, endDate);
      const data = await this.svc.trialBalance(companyId, s, e);
      return this.send(data, format, res, 'trial-balance');
    }
    if (mode !== 'movement' && mode !== 'closing' && mode !== 'working') {
      throw new BadRequestException({
        code: 'INVALID_MODE',
        message: "mode must be 'movement', 'closing' or 'working'.",
      });
    }
    const { s, e } = this.checkedRange(
      startDate,
      endDate || (mode === 'movement' ? undefined : reportToday()),
    );
    const data = await this.svc.trialBalance(companyId, s, e, mode, {
      includeZero: includeZero === 'true',
    });
    return this.send(data, format, res, 'trial-balance', LEGACY_KEYS.trialBalance);
  }

  @Get('cash-flow')
  @Roles('admin', 'staff')
  async cashFlow(
    @CurrentCompany() companyId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('format') format = 'json',
    @Res() res: Response,
  ) {
    const data = await this.svc.cashFlow(
      companyId,
      startDate || REPORT_RANGE_DEFAULTS.startDate,
      endDate || reportToday(),
    );
    return this.send(data, format, res, 'cash-flow', LEGACY_KEYS.cashFlow);
  }

  /**
   * The cash rows behind one cash-flow line (`lineKey` from the statement),
   * with the part of each allocated to the line. Σ allocatedAmount over every
   * page = the line's amount. Envelope route; rows under `entries`.
   */
  @Get('cash-flow/lines/:lineKey/entries')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Cash rows behind a cash-flow line (v2)' })
  @ApiParam({ name: 'lineKey', description: 'e.g. op.customers, inv.fixed_assets, fin.loans' })
  @ApiQuery({ name: 'startDate', required: false })
  @ApiQuery({ name: 'endDate', required: false, description: 'default today' })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false, description: 'max 200' })
  @ApiOkResponse({ description: '{ lineKey, label, section, lineAmount, entries[], total, page, limit }' })
  async cashFlowLineEntries(
    @CurrentCompany() companyId: string,
    @Param('lineKey') lineKey: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 50,
  ) {
    const { s, e } = this.checkedRange(startDate, endDate || reportToday());
    return this.svc.cashFlowLineEntries(companyId, lineKey, s, e, page, limit);
  }

  @Get('delivery-report')
  @Roles('admin', 'staff')
  async deliveryReport(
    @CurrentCompany() companyId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('format') format = 'json',
    @Res() res: Response,
  ) {
    const data = await this.svc.deliveryReport(companyId, startDate, endDate);
    return this.send(data, format, res, 'delivery-report');
  }

  @Get('dashboard')
  @Roles('admin', 'staff')
  async dashboard(@CurrentCompany() companyId: string) {
    return this.svc.dashboardSummary(companyId);
  }

  @Get('delivery-daily')
  @Roles('admin', 'staff')
  async deliveryDaily(@CurrentCompany() companyId: string) {
    return this.svc.deliveryDaily(companyId);
  }

  @Get('delivery-performance')
  @Roles('admin', 'staff')
  async deliveryPerformance(@CurrentCompany() companyId: string) {
    return this.svc.deliveryPerformance(companyId);
  }

  @Get('analytics-dashboard')
  @Roles('admin', 'staff')
  async analyticsDashboard(@CurrentCompany() companyId: string) {
    return this.svc.analyticsDashboard(companyId);
  }

  @Get('aging')
  @Roles('admin', 'staff')
  async aging(
    @CurrentCompany() companyId: string,
    @Query() query: UnifiedAgingQueryDto,
    @Res() res: Response,
  ) {
    const data = await this.svc.aging(companyId, query);
    return this.send(data, query.format ?? 'json', res, 'aging');
  }

  /** An account number as the chart stores it, or a coded 400. */
  private checkedAccountCode(code: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/.test(code ?? '')) {
      throw new BadRequestException({
        code: 'INVALID_ACCOUNT_CODE',
        message: 'accountCode must be an account number.',
      });
    }
    return code;
  }

  /**
   * A real calendar date or a coded 400 — for the routes that accept a single
   * as-of date rather than a range.
   */
  private checkedDate(name: string, v: string) {
    if (!isIsoDate(v)) {
      throw new BadRequestException({
        code: 'INVALID_DATE',
        message: `${name} must be a real date in YYYY-MM-DD form.`,
      });
    }
    return v;
  }

  /**
   * @param legacyKeys for a report that has grown v2 fields: the keys it had
   *   before them. The CSV export flattens the whole object into one row, so
   *   every new top-level field would add a column to a file someone's
   *   spreadsheet already reads. CSV gets exactly the old keys; JSON gets all.
   */
  private send(
    data: unknown,
    format: string,
    res: Response,
    filename: string,
    legacyKeys?: readonly string[],
  ) {
    if (format === 'csv') {
      if (legacyKeys && data && typeof data === 'object' && !Array.isArray(data)) {
        data = Object.fromEntries(
          legacyKeys
            .filter((k) => k in (data as Record<string, unknown>))
            .map((k) => [k, (data as Record<string, unknown>)[k]]),
        );
      }
      const csv = Array.isArray(data) ? this.svc.toCsv(data as Record<string, unknown>[]) : this.svc.toCsv([data as Record<string, unknown>]);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(csv);
      return;
    }
    res.json(data);
  }
}
