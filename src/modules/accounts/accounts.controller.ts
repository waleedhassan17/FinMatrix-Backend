import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { AccountsService } from './accounts.service';
import {
  CreateAccountDto,
  ListAccountsQueryDto,
  UpdateAccountDto,
} from './dto/account.dto';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('accounts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('accounts')
export class AccountsController {
  constructor(private readonly accounts: AccountsService) {}

  @Get()
  @ApiOperation({ summary: 'List accounts with filters. Includes summary totals.' })
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListAccountsQueryDto,
  ) {
    return this.accounts.list(companyId, query);
  }

  @Get(':accountId')
  @ApiOperation({ summary: 'Account detail with last 10 GL entries.' })
  detail(
    @CurrentCompany() companyId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ) {
    return this.accounts.getDetail(companyId, accountId);
  }

  @Post()
  @Roles('admin')
  @ApiOperation({ summary: 'Create a new account.' })
  create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateAccountDto,
  ) {
    return this.accounts.create(companyId, dto);
  }

  @Patch(':accountId')
  @Roles('admin')
  @ApiOperation({
    summary: 'Update account. accountNumber and type are immutable.',
  })
  update(
    @CurrentCompany() companyId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Body() dto: UpdateAccountDto,
  ) {
    return this.accounts.update(companyId, accountId, dto);
  }

  @Patch(':accountId/toggle')
  @Roles('admin')
  @ApiOperation({ summary: 'Flip isActive on the account.' })
  toggle(
    @CurrentCompany() companyId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
  ) {
    return this.accounts.toggle(companyId, accountId);
  }

  @Get(':accountId/transactions')
  @ApiOperation({ summary: 'Paginated GL entries for this account.' })
  transactions(
    @CurrentCompany() companyId: string,
    @Param('accountId', ParseUUIDPipe) accountId: string,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.accounts.transactions(companyId, accountId, pagination);
  }
}
