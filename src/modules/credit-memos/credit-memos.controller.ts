import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { CreditMemosService } from './credit-memos.service';
import { ApplyCreditMemoDto, CreateCreditMemoDto, ListCreditMemosQueryDto } from './dto/credit-memo.dto';
import { ParsePaginationPipe, PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';

@ApiTags('credit-memos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@RequiresFeature('creditMemos') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
@Controller('credit-memos')
export class CreditMemosController {
  constructor(private readonly svc: CreditMemosService) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListCreditMemosQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.svc.list(companyId, query, pagination);
  }

  @Get(':id')
  get(@CurrentCompany() companyId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getById(companyId, id);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCreditMemoDto,
  ) {
    return this.svc.create(companyId, user.id, dto);
  }

  @Post(':id/apply')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Apply available credit to an outstanding invoice.' })
  apply(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyCreditMemoDto,
  ) {
    return this.svc.applyToInvoice(companyId, id, dto);
  }

  @Post(':id/refund')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refund the remaining credit balance to the customer (cash).' })
  refund(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.refund(companyId, id, user.id);
  }

  @Post(':id/void')
  @Roles('admin')
  @HttpCode(200)
  void(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.void(companyId, id, user.id);
  }

  @Delete(':id')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.delete(companyId, id, user.id);
  }
}
