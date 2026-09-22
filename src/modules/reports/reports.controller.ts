import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
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
import { AgingQueryDto, UnifiedAgingQueryDto } from './dto/aging-query.dto';
import { AgingDetailQueryDto } from './dto/aging-detail-query.dto';

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

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

  @Get('balance-sheet')
  @Roles('admin', 'staff')
  async balanceSheet(
    @CurrentCompany() companyId: string,
    @Query('asOfDate') asOfDate: string,
    @Query('format') format = 'json',
    @Res() res: Response,
  ) {
    const data = await this.svc.balanceSheet(companyId, asOfDate || reportToday());
    return this.send(data, format, res, 'balance-sheet');
  }

  @Get('ar-aging')
  @Roles('admin', 'staff')
  async arAging(
    @CurrentCompany() companyId: string,
    @Query() query: AgingQueryDto,
    @Res() res: Response,
  ) {
    const data = await this.svc.arAging(companyId, query);
    return this.send(data, query.format ?? 'json', res, 'ar-aging');
  }

  @Get('ap-aging')
  @Roles('admin', 'staff')
  async apAging(
    @CurrentCompany() companyId: string,
    @Query() query: AgingQueryDto,
    @Res() res: Response,
  ) {
    const data = await this.svc.apAging(companyId, query);
    return this.send(data, query.format ?? 'json', res, 'ap-aging');
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

  @Get('inventory-valuation')
  @Roles('admin', 'staff')
  async inventoryValuation(
    @CurrentCompany() companyId: string,
    @Query('format') format = 'json',
    @Res() res: Response,
  ) {
    const data = await this.svc.inventoryValuation(companyId);
    return this.send(data, format, res, 'inventory-valuation');
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
  ) {
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
    const { s, e } = this.range(startDate, endDate);
    return this.svc.itemPerformance(companyId, itemId, s, e);
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
    const { s, e } = this.range(startDate, endDate);
    const allowed = ['grossProfit', 'revenue', 'marginPct', 'stockValue'] as const;
    const key = (allowed as readonly string[]).includes(sort ?? '')
      ? (sort as (typeof allowed)[number])
      : 'grossProfit';
    return this.svc.inventoryPerformance(companyId, s, e, key);
  }

  @Get('trial-balance')
  @Roles('admin', 'staff')
  async trialBalance(
    @CurrentCompany() companyId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('format') format = 'json',
    @Res() res: Response,
  ) {
    const { s, e } = this.range(startDate, endDate);
    const data = await this.svc.trialBalance(companyId, s, e);
    return this.send(data, format, res, 'trial-balance');
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
    return this.send(data, format, res, 'cash-flow');
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

  private send(data: unknown, format: string, res: Response, filename: string) {
    if (format === 'csv') {
      const csv = Array.isArray(data) ? this.svc.toCsv(data as Record<string, unknown>[]) : this.svc.toCsv([data as Record<string, unknown>]);
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
      res.send(csv);
      return;
    }
    res.json(data);
  }
}
