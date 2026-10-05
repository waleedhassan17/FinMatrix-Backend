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
import { VendorsService } from './vendors.service';
import { PartyLedgerService } from '../ledger/party-ledger.service';
import { PartyHistoryService } from '../ledger/party-history.service';
import {
  CreateVendorDto,
  ListVendorsQueryDto,
  UpdateVendorDto,
  VendorStatementQueryDto,
} from './dto/vendor.dto';
import { Delete, HttpCode } from '@nestjs/common';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('vendors')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
// Owners and staff only, reads included. Without a role here the GET routes
// answered any company member, so a delivery rider could list every vendor
// and read their balances and statements. A rider's deliveries already carry
// the vendor details the job needs. Routes that name their own @Roles
// (create, edit, delete) keep their narrower set.
@Roles('admin', 'staff')
@Controller('vendors')
export class VendorsController {
  constructor(
    private readonly vendors: VendorsService,
    private readonly partyLedger: PartyLedgerService,
    private readonly partyHistory: PartyHistoryService,
  ) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListVendorsQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.vendors.list(companyId, query, pagination);
  }

  // Literal paths sit above ':vendorId', whose UUID pipe would refuse them.
  @Get('next-code')
  nextCode(@CurrentCompany() companyId: string) {
    return this.vendors.nextCode(companyId);
  }

  @Get(':vendorId')
  get(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
  ) {
    return this.vendors.getById(companyId, vendorId);
  }

  @Post()
  @Roles('admin', 'staff')
  create(@CurrentCompany() companyId: string, @Body() dto: CreateVendorDto) {
    return this.vendors.create(companyId, dto);
  }

  @Patch(':vendorId')
  @Roles('admin', 'staff')
  update(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
    @Body() dto: UpdateVendorDto,
  ) {
    return this.vendors.update(companyId, vendorId, dto);
  }

  @Get(':vendorId/bills')
  bills(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.vendors.bills(companyId, vendorId, pagination);
  }

  @Get(':vendorId/payments')
  payments(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.vendors.payments(companyId, vendorId, pagination);
  }

  @Get(':vendorId/statement')
  statement(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
    @Query() query: VendorStatementQueryDto,
  ) {
    return this.vendors.statement(companyId, vendorId, query);
  }

  /** The statement read from the books (see CustomersController.ledgerStatement). */
  @Get(':vendorId/ledger-statement')
  @ApiOperation({ summary: 'Period statement from the ledger: opening + lines + closing.' })
  ledgerStatement(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
    @Query() query: VendorStatementQueryDto,
  ) {
    return this.partyLedger.statement(companyId, 'vendor', vendorId, query.startDate, query.endDate);
  }

  @Get(':vendorId/history')
  @ApiOperation({ summary: 'History: since, last bill/payment, months of the fiscal year, edit log (owner).' })
  history(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('year') year?: string,
  ) {
    return this.partyHistory.history(
      companyId,
      'vendor',
      vendorId,
      { role: user?.role ?? 'staff' },
      year ? parseInt(year, 10) : undefined,
    );
  }

  @Delete(':vendorId')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
  ) {
    return this.vendors.delete(companyId, vendorId);
  }

  @Patch(':vendorId/toggle-active')
  @Roles('admin')
  @HttpCode(200)
  toggleActive(
    @CurrentCompany() companyId: string,
    @Param('vendorId', ParseUUIDPipe) vendorId: string,
  ) {
    return this.vendors.toggleActive(companyId, vendorId);
  }
}
