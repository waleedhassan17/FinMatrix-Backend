import {
  Body, Controller, Delete, Get, Param, ParseUUIDPipe,
  ParseIntPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { BudgetsService } from './budgets.service';
import { CreateBudgetDto, ListBudgetsQueryDto, UpdateBudgetDto } from './dto/budget.dto';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';

@ApiTags('budgets')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@RequiresFeature('budgets') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
@Controller('budgets')
export class BudgetsController {
  constructor(private readonly svc: BudgetsService) {}

  @Get()
  @Roles('admin', 'staff')
  list(@CurrentCompany() companyId: string, @Query() query: ListBudgetsQueryDto) {
    return this.svc.list(companyId, query);
  }

  /**
   * QuickBooks "create budget from previous year's data": per-account
   * monthly actuals for the given fiscal year, ready to use as a new
   * budget's monthlyAmounts. Registered BEFORE :id so 'prefill' never
   * matches the UUID param route.
   */
  @Get('prefill')
  @Roles('admin', 'staff')
  prefill(
    @CurrentCompany() companyId: string,
    @Query('fiscalYear', new ParseIntPipe({ optional: true })) fiscalYear?: number,
  ) {
    return this.svc.prefillFromActuals(companyId, fiscalYear ?? new Date().getFullYear() - 1);
  }

  @Get(':id')
  @Roles('admin', 'staff')
  get(@CurrentCompany() companyId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getById(companyId, id);
  }

  @Get(':id/vs-actual')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Budget vs Actual comparison for the fiscal year.' })
  vsActual(@CurrentCompany() companyId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.budgetVsActual(companyId, id);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBudgetDto,
  ) {
    return this.svc.create(companyId, user.id, dto);
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
  remove(@CurrentCompany() companyId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.delete(companyId, id);
  }
}
