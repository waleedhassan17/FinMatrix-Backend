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
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { CustomersService } from './customers.service';
import { PartyLedgerService } from '../ledger/party-ledger.service';
import { PartyHistoryService } from '../ledger/party-history.service';
import {
  CreateCustomerDto,
  ListCustomersQueryDto,
  StatementQueryDto,
  UpdateCustomerDto,
} from './dto/customer.dto';
import { Delete, HttpCode } from '@nestjs/common';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('customers')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
// Owners and staff only, reads included. Without a role here the GET routes
// answered any company member, so a delivery rider could list every customer
// and read their balances and statements. A rider's deliveries already carry
// the customer details the job needs. Routes that name their own @Roles
// (create, edit, delete) keep their narrower set.
@Roles('admin', 'staff')
@Controller('customers')
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly partyLedger: PartyLedgerService,
    private readonly partyHistory: PartyHistoryService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List customers with filters + summary.' })
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListCustomersQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.customers.list(companyId, query, pagination);
  }

  // Literal paths sit above ':customerId', whose UUID pipe would refuse them.
  @Get('next-code')
  @ApiOperation({ summary: 'The customer ID the next new customer would get (a suggestion, not a reservation).' })
  nextCode(@CurrentCompany() companyId: string) {
    return this.customers.nextCode(companyId);
  }

  @Get(':customerId')
  @ApiOperation({ summary: 'Customer detail + recent activity + credit calc.' })
  detail(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.customers.detail(companyId, customerId);
  }

  @Post()
  @Roles('admin', 'staff')
  create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateCustomerDto,
  ) {
    return this.customers.create(companyId, dto);
  }

  @Patch(':customerId')
  @Roles('admin', 'staff')
  update(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customers.update(companyId, customerId, dto);
  }

  @Get(':customerId/invoices')
  invoices(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.customers.invoices(companyId, customerId, pagination);
  }

  @Get(':customerId/payments')
  payments(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.customers.payments(companyId, customerId, pagination);
  }

  @Get(':customerId/statement')
  @ApiOperation({ summary: 'Period statement: opening + activity + closing.' })
  statement(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: StatementQueryDto,
  ) {
    return this.customers.statement(companyId, customerId, query);
  }

  /**
   * The statement read from the books — the same postings as the customer's
   * view in the General Ledger, so the two always agree. `/statement` above
   * stays for app builds that read its document arrays.
   */
  @Get(':customerId/ledger-statement')
  @ApiOperation({ summary: 'Period statement from the ledger: opening + lines + closing.' })
  ledgerStatement(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: StatementQueryDto,
  ) {
    return this.partyLedger.statement(companyId, 'customer', customerId, query.startDate, query.endDate);
  }

  @Get(':customerId/history')
  @ApiOperation({ summary: 'History: since, last invoice/payment, months of the fiscal year, edit log (owner).' })
  history(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('year') year?: string,
  ) {
    return this.partyHistory.history(
      companyId,
      'customer',
      customerId,
      { role: user?.role ?? 'staff' },
      year ? parseInt(year, 10) : undefined,
    );
  }

  @Delete(':customerId')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.customers.delete(companyId, customerId);
  }

  @Patch(':customerId/toggle-active')
  @Roles('admin')
  @HttpCode(200)
  toggleActive(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.customers.toggleActive(companyId, customerId);
  }
}
