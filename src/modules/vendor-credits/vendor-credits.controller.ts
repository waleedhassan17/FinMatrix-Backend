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
import { ApprovalRequestsService } from '../approvals/approval-requests.service';
import { VendorCreditsService } from './vendor-credits.service';
import { ApplyVendorCreditDto, CreateVendorCreditDto, ListVendorCreditsQueryDto } from './dto/vendor-credit.dto';
import { ParsePaginationPipe, PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';

@ApiTags('vendor-credits')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@RequiresFeature('creditMemos') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
// Financial data: company staff only — the delivery role must never read
// or write here (handler-level @Roles overrides where narrower).
@Roles('admin', 'staff')
@Controller('vendor-credits')
export class VendorCreditsController {
  constructor(
    private readonly svc: VendorCreditsService,
    private readonly approvals: ApprovalRequestsService,
  ) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListVendorCreditsQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.svc.list(companyId, query, pagination);
  }

  @Get(':id')
  get(@CurrentCompany() companyId: string, @Param('id', ParseUUIDPipe) id: string) {
    return this.svc.getById(companyId, id);
  }

  /**
   * A vendor credit reverses a billed purchase (Dr Accounts Payable /
   * Cr Inventory), so staff prepare it and the owner approves — Table B,
   * "return after a purchase is billed".
   */
  @Post()
  @Roles('admin', 'staff')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateVendorCreditDto,
  ) {
    if (user.role === 'admin') return this.svc.create(companyId, user.id, dto);
    return this.approvals.createRequest(
      'vendor_credit',
      { action: 'create', ...dto },
      'Vendor credit for a return to the supplier',
      user,
      companyId,
    );
  }

  @Post(':id/apply')
  @Roles('admin', 'staff')
  @HttpCode(200)
  @ApiOperation({ summary: 'Apply available vendor credit to an open bill.' })
  apply(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyVendorCreditDto,
  ) {
    if (user.role === 'admin') return this.svc.applyToBill(companyId, id, dto);
    return this.approvals.createRequest(
      'vendor_credit',
      { action: 'apply', vendorCreditId: id, ...dto },
      'Apply a vendor credit to a bill',
      user,
      companyId,
    );
  }

  @Post(':id/void')
  @Roles('admin', 'staff')
  @HttpCode(200)
  void(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    if (user.role === 'admin') return this.svc.void(companyId, id, user.id);
    return this.approvals.createRequest(
      'void',
      { entity: 'vendor_credit', targetId: id },
      'Void a vendor credit',
      user,
      companyId,
    );
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
