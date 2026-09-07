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
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { PaymentsService } from './payments.service';
import { ApprovalRequestsService } from '../approvals/approval-requests.service';
import { ListPaymentsQueryDto, ReceivePaymentDto } from './dto/payment.dto';
import { Delete } from '@nestjs/common';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('payments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
// Financial data: company staff only — the delivery role must never read
// or write here (handler-level @Roles overrides where narrower).
@Roles('admin', 'staff')
@Controller('payments')
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly approvals: ApprovalRequestsService,
  ) {}

  /**
   * Banking a customer payment was value IN and direct for staff. It is the
   * cash-IN mirror of paying a bill, which has always been gated, and the owner
   * asked for the same signature here: nothing moves until they approve.
   *
   * The gate is in the controller, not the service, so the delivery flow — which
   * settles its invoice through PaymentsService directly on the owner's own
   * sign-off — keeps working untouched.
   *
   * A payment replayed later can fail honestly: the invoice may have been paid,
   * voided or credited in between, leaving the allocations larger than what is
   * still outstanding. The dispatcher lets that throw so it lands on the
   * request's lastError, rather than forcing a payment that no longer fits.
   */
  @Post()
  @Roles('admin', 'staff')
  @ApiOperation({
    summary: 'Receive customer payment. Auto-applies if no applications given.',
  })
  receive(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReceivePaymentDto,
  ) {
    if (user.role === 'admin') return this.payments.receive(companyId, user.id, dto);
    return this.approvals.createRequest(
      'invoice_payment',
      dto as unknown as Record<string, unknown>,
      `Customer payment of ${dto.amount} by ${dto.paymentMethod} dated ${dto.paymentDate}`,
      user,
      companyId,
    );
  }

  @Get('customer/:customerId/outstanding')
  @ApiOperation({ summary: 'List unpaid invoices for a customer.' })
  outstanding(
    @CurrentCompany() companyId: string,
    @Param('customerId', ParseUUIDPipe) customerId: string,
  ) {
    return this.payments.outstanding(companyId, customerId);
  }

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListPaymentsQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.payments.list(companyId, query, pagination);
  }

  @Get(':paymentId')
  get(
    @CurrentCompany() companyId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
  ) {
    return this.payments.getById(companyId, paymentId);
  }

  @Delete(':paymentId')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @Param('paymentId', ParseUUIDPipe) paymentId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.payments.delete(companyId, paymentId, user.id);
  }
}
