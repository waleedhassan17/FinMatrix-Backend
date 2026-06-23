import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
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

@ApiTags('payroll')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller()
export class PayrollController {
  constructor(private readonly svc: PayrollService) {}

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
}
