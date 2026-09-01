import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
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
import { Delete } from '@nestjs/common';
import { ApprovalRequestsService } from '../approvals/approval-requests.service';
import { BillsService } from './bills.service';
import {
  CreateBillDto,
  ListBillsQueryDto,
  PayBillsDto,
  UpdateBillDto,
} from './dto/bill.dto';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('bills')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
// `bill` is a backwards-compat alias for older app builds that called the
// singular `/api/v1/bill` route; both prefixes resolve to the same handlers.
// Financial data: company staff only — the delivery role must never read
// or write here (handler-level @Roles overrides where narrower).
@Roles('admin', 'staff')
@Controller(['bills', 'bill'])
export class BillsController {
  constructor(
    private readonly bills: BillsService,
    private readonly approvals: ApprovalRequestsService,
  ) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListBillsQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.bills.list(companyId, query, pagination);
  }

  // Payment history for a single bill. The app's bill-detail screen requests
  // GET /bills/:billId/payments; declared before `:billId` so it matches first.
  @Get(':billId/payments')
  payments(
    @CurrentCompany() companyId: string,
    @Param('billId', ParseUUIDPipe) billId: string,
  ) {
    return this.bills.getBillPaymentHistory(companyId, billId);
  }

  @Get(':billId')
  get(
    @CurrentCompany() companyId: string,
    @Param('billId', ParseUUIDPipe) billId: string,
  ) {
    return this.bills.getById(companyId, billId);
  }

  @Post()
  @Roles('admin', 'staff')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateBillDto,
  ) {
    return this.bills.create(companyId, user.id, dto);
  }

  @Patch(':billId')
  @Roles('admin', 'staff')
  update(
    @CurrentCompany() companyId: string,
    @Param('billId', ParseUUIDPipe) billId: string,
    @Body() dto: UpdateBillDto,
  ) {
    return this.bills.update(companyId, billId, dto);
  }

  /**
   * A second door into BillsService.pay — POST /bill-payments is the other.
   * Both must gate the same way or the stricter one is just a detour: money
   * leaving the bank is money leaving the bank whichever route recorded it.
   */
  @Post('pay')
  @Roles('admin', 'staff')
  @HttpCode(200)
  pay(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: PayBillsDto,
  ) {
    if (user.role === 'admin') return this.bills.pay(companyId, user.id, dto);
    return this.approvals.createRequest(
      'bill_payment',
      dto as unknown as Record<string, unknown>,
      `Bill payment by ${dto.paymentMethod} dated ${dto.paymentDate}`,
      user,
      companyId,
    );
  }

  @Post(':billId/post')
  @Roles('admin', 'staff')
  post(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('billId', ParseUUIDPipe) billId: string,
  ) {
    return this.bills.post(companyId, billId, user.id);
  }

  @Delete(':billId')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('billId', ParseUUIDPipe) billId: string,
  ) {
    return this.bills.delete(companyId, billId, user.id);
  }
}
