import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { PayrollService } from './payroll.service';
import { CreatePayrollRunDto, UpdatePayrollRunDto } from './dto/payroll.dto';
import { HttpCode } from '@nestjs/common';

@ApiTags('Payroll')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('payroll')
export class PayrollController {
  constructor(private readonly svc: PayrollService) {}

  @Get()
  @Roles('admin', 'staff')
  list(
    @CurrentCompany() companyId: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.list(companyId, page, limit);
  }

  @Get('worksheet')
  @Roles('admin', 'staff')
  worksheet(@CurrentCompany() companyId: string) {
    return this.svc.getWorksheet(companyId);
  }

  @Post('runs')
  @Roles('admin', 'staff')
  createRun(
    @CurrentCompany() companyId: string,
    @Body() dto: CreatePayrollRunDto,
  ) {
    return this.svc.create(companyId, dto, 'user-id');
  }

  @Get(':id')
  @Roles('admin', 'staff')
  get(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.getById(companyId, id);
  }

  @Patch(':id/status')
  @Roles('admin', 'staff')
  updateStatus(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePayrollRunDto,
  ) {
    return this.svc.updateStatus(companyId, id, dto);
  }

  @Get('pay-stubs/:payrollRunId')
  @Roles('admin', 'staff')
  @HttpCode(200)
  payStubs(
    @CurrentCompany() companyId: string,
    @Param('payrollRunId', ParseUUIDPipe) payrollRunId: string,
  ) {
    return this.svc.getPayStubs(companyId, payrollRunId);
  }
}
