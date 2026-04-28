import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { ReportsService } from './reports.service';

@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('reports')
export class ReportsController {
  constructor(private readonly svc: ReportsService) {}

  @Get('profit-loss')
  @Roles('admin', 'staff')
  async profitLoss(
    @CurrentCompany() companyId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('format') format = 'json',
    @Res() res: Response,
  ) {
    const data = await this.svc.profitLoss(companyId, startDate, endDate);
    return this.send(data, format, res, 'profit-loss');
  }

  @Get('balance-sheet')
  @Roles('admin', 'staff')
  async balanceSheet(
    @CurrentCompany() companyId: string,
    @Query('asOfDate') asOfDate: string,
    @Query('format') format = 'json',
    @Res() res: Response,
  ) {
    const data = await this.svc.balanceSheet(companyId, asOfDate);
    return this.send(data, format, res, 'balance-sheet');
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
    const data = await this.svc.cashFlow(companyId, startDate, endDate);
    return this.send(data, format, res, 'cash-flow');
  }

  @Get('ar-aging')
  @Roles('admin', 'staff')
  async arAging(
    @CurrentCompany() companyId: string,
    @Query('format') format = 'json',
    @Res() res: Response,
  ) {
    const data = await this.svc.arAging(companyId);
    return this.send(data, format, res, 'ar-aging');
  }

  @Get('ap-aging')
  @Roles('admin', 'staff')
  async apAging(
    @CurrentCompany() companyId: string,
    @Query('format') format = 'json',
    @Res() res: Response,
  ) {
    const data = await this.svc.apAging(companyId);
    return this.send(data, format, res, 'ap-aging');
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

  @Get('tax-report')
  @Roles('admin', 'staff')
  async taxReport(
    @CurrentCompany() companyId: string,
    @Query('startDate') startDate: string,
    @Query('endDate') endDate: string,
    @Query('format') format = 'json',
    @Res() res: Response,
  ) {
    const data = await this.svc.taxReport(companyId, startDate, endDate);
    return this.send(data, format, res, 'tax-report');
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

  @Get('budget-comparison')
  @Roles('admin', 'staff')
  async budgetComparison(
    @CurrentCompany() companyId: string,
    @Query('budgetId') budgetId: string,
  ) {
    return this.svc.budgetComparison(companyId, budgetId);
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

  @Get('sales-by-customer')
  @Roles('admin', 'staff')
  async salesByCustomer(@CurrentCompany() companyId: string) {
    return this.svc.salesByCustomer(companyId);
  }

  @Get('sales-by-item')
  @Roles('admin', 'staff')
  async salesByItem(@CurrentCompany() companyId: string) {
    return this.svc.salesByItem(companyId);
  }

  @Get('analytics-dashboard')
  @Roles('admin', 'staff')
  async analyticsDashboard(@CurrentCompany() companyId: string) {
    return this.svc.analyticsDashboard(companyId);
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
