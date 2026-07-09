import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { Response } from 'express';
import { Company } from '../companies/entities/company.entity';
import { PayslipPdfService } from './payslip-pdf.service';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { PayrollService } from './payroll.service';
import {
  CreateEmployeeDto, CreatePayrollRunDto, ListEmployeesQueryDto, UpdateEmployeeDto,
} from './dto/payroll.dto';
import { ParsePaginationPipe, PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';

@ApiTags('payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@RequiresFeature('payroll') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
@Controller()
export class PayrollController {
  constructor(
    private readonly svc: PayrollService,
    private readonly payslipPdf: PayslipPdfService,
    @InjectRepository(Company) private readonly companyRepo: Repository<Company>,
  ) {}

  // ── Employees ──
  @Get('employees')
  @Roles('admin')
  listEmployees(
    @CurrentCompany() companyId: string,
    @Query() query: ListEmployeesQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.svc.listEmployees(companyId, query, pagination);
  }

  @Get('employees/:id')
  @Roles('admin')
  getEmployee(@CurrentCompany() companyId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getEmployee(companyId, id);
  }

  @Post('employees')
  @Roles('admin')
  createEmployee(@CurrentCompany() companyId: string, @Body() dto: CreateEmployeeDto) {
    return this.svc.createEmployee(companyId, dto);
  }

  @Patch('employees/:id')
  @Roles('admin')
  updateEmployee(@CurrentCompany() companyId: string, @Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateEmployeeDto) {
    return this.svc.updateEmployee(companyId, id, dto);
  }

  @Delete('employees/:id')
  @Roles('admin')
  deleteEmployee(@CurrentCompany() companyId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.deleteEmployee(companyId, id);
  }

  // ── Payroll runs ──
  @Get('payroll/runs')
  @Roles('admin')
  listRuns(@CurrentCompany() companyId: string) {
    return this.svc.listRuns(companyId);
  }

  @Get('payroll/runs/:id')
  @Roles('admin')
  getRun(@CurrentCompany() companyId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getRun(companyId, id);
  }

  @Post('payroll/runs')
  @Roles('admin')
  @ApiOperation({ summary: 'Build a payroll worksheet (defaults to all active employees).' })
  createRun(@CurrentCompany() companyId: string, @CurrentUser() user: AuthenticatedUser, @Body() dto: CreatePayrollRunDto) {
    return this.svc.createRun(companyId, user.id, dto);
  }

  @Post('payroll/runs/:id/process')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Process payroll: post JE (DR wages, CR cash + deductions), mark paid.' })
  processRun(@CurrentCompany() companyId: string, @CurrentUser() user: AuthenticatedUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.processRun(companyId, id, user.id);
  }

  @Delete('payroll/runs/:id')
  @Roles('admin')
  deleteRun(@CurrentCompany() companyId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.deleteRun(companyId, id);
  }

  @Get('payroll/runs/:runId/payslip/:employeeId/pdf')
  @Roles('admin')
  @ApiOperation({ summary: 'Official PDF payslip for one employee on a processed run (figures from the posted entry).' })
  async payslipPdfStream(
    @CurrentCompany() companyId: string,
    @Param('runId', ParseUUIDPipe) runId: string,
    @Param('employeeId', ParseUUIDPipe) employeeId: string,
    @Res() res: Response,
  ) {
    const { run, item, employee } = await this.svc.getPayslipData(companyId, runId, employeeId);
    const company = await this.companyRepo.findOneByOrFail({ id: companyId });

    const safe = (v: string) => v.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 60);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="Payslip_${safe(run.payPeriod)}_${safe(`${employee.firstName}_${employee.lastName}`)}.pdf"`,
    );
    this.payslipPdf.render({ company, employee, run, item }).pipe(res);
  }
}
