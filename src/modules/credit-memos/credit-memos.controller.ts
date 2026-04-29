import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { CreditMemosService } from './credit-memos.service';
import {
  ApplyCreditMemoDto,
  CreateCreditMemoDto,
  RefundCreditMemoDto,
} from './dto/credit-memo.dto';
import { Delete, HttpCode, Patch } from '@nestjs/common';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('credit-memos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('credit-memos')
export class CreditMemosController {
  constructor(private readonly service: CreditMemosService) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.service.list(companyId, pagination);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCreditMemoDto,
  ) {
    return this.service.create(companyId, user.id, dto);
  }

  @Post(':creditId/apply')
  @Roles('admin')
  apply(
    @CurrentCompany() companyId: string,
    @Param('creditId', ParseUUIDPipe) creditId: string,
    @Body() dto: ApplyCreditMemoDto,
  ) {
    return this.service.apply(companyId, creditId, dto);
  }

  @Post(':creditId/refund')
  @Roles('admin')
  refund(
    @CurrentCompany() companyId: string,
    @Param('creditId', ParseUUIDPipe) creditId: string,
    @Body() dto: RefundCreditMemoDto,
  ) {
    return this.service.refund(companyId, creditId, dto);
  }

  @Get(':creditId')
  @Roles('admin', 'staff')
  get(
    @CurrentCompany() companyId: string,
    @Param('creditId', ParseUUIDPipe) creditId: string,
  ) {
    return this.service.getById(companyId, creditId);
  }

  @Patch(':creditId')
  @Roles('admin')
  update(
    @CurrentCompany() companyId: string,
    @Param('creditId', ParseUUIDPipe) creditId: string,
    @Body() dto: CreateCreditMemoDto,
  ) {
    return this.service.update(companyId, creditId, dto);
  }

  @Delete(':creditId')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @Param('creditId', ParseUUIDPipe) creditId: string,
  ) {
    return this.service.delete(companyId, creditId);
  }

  @Post(':creditId/void')
  @Roles('admin')
  @HttpCode(200)
  voidMemo(
    @CurrentCompany() companyId: string,
    @Param('creditId', ParseUUIDPipe) creditId: string,
  ) {
    return this.service.void(companyId, creditId);
  }
}
