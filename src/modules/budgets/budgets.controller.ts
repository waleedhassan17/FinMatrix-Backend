import { Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { BudgetsService } from './budgets.service';
import { CreateBudgetDto, UpdateBudgetDto } from './dto/budget.dto';
import { HttpCode } from '@nestjs/common';

@ApiTags('Budgets')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('budgets')
export class BudgetsController {
  constructor(private readonly svc: BudgetsService) {}

  @Get()
  @Roles('admin', 'staff')
  list(
    @CurrentCompany() companyId: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.list(companyId, page, limit);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateBudgetDto,
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

  @Patch(':id')
  @Roles('admin')
  update(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateBudgetDto,
  ) {
    return this.svc.update(companyId, id, dto);
  }

  @Delete(':id')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.remove(companyId, id);
  }

  @Post('copy-from-last-year')
  @Roles('admin')
  @HttpCode(200)
  copy(
    @CurrentCompany() companyId: string,
    @Body() dto: { sourceFiscalYear: number; targetFiscalYear: number; name: string },
  ) {
    return this.svc.copyFromLastYear(companyId, dto.sourceFiscalYear, dto.targetFiscalYear, dto.name, 'user-id');
  }
}
