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
import { CreditMemosService } from './credit-memos.service';
import { ApplyCreditMemoDto, CreateCreditMemoDto, ListCreditMemosQueryDto } from './dto/credit-memo.dto';
import { ParsePaginationPipe, PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';

@ApiTags('credit-memos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@RequiresFeature('creditMemos') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
// Financial data: company staff only — the delivery role must never read
// or write here (handler-level @Roles overrides where narrower).
@Roles('admin', 'staff')
@Controller('credit-memos')
export class CreditMemosController {
  constructor(
    private readonly svc: CreditMemosService,
    private readonly approvals: ApprovalRequestsService,
  ) {}

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

  /**
   * A credit memo reverses a posted sale (Dr Sales / Cr A/R, Dr Inventory /
   * Cr COGS), so staff prepare it and the owner approves — Table B, "customer
   * return after sale".
   */
  @Post()
  @Roles('admin', 'staff')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCreditMemoDto,
  ) {
    // createAndApply is a no-op beyond create() unless applyToInvoiceId is
    // set, so this one call covers both an ordinary credit memo and a delivery
    // reversal — and staff's approved request runs the very same method.
    if (user.role === 'admin') return this.svc.createAndApply(companyId, user.id, dto);
    return this.approvals.createRequest(
      'credit_memo',
      { action: 'create', ...dto },
      `Credit memo for a customer return — ${dto.reason ?? `${dto.lines?.length ?? 0} line(s)`}`,
      user,
      companyId,
    );
  }

  @Post(':id/apply')
  @Roles('admin', 'staff')
  @HttpCode(200)
  @ApiOperation({ summary: 'Apply available credit to an outstanding invoice.' })
  apply(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyCreditMemoDto,
  ) {
    if (user.role === 'admin') return this.svc.applyToInvoice(companyId, id, dto);
    return this.approvals.createRequest(
      'credit_memo',
      { action: 'apply', creditMemoId: id, ...dto },
      'Apply a credit memo to an invoice',
      user,
      companyId,
    );
  }

  // Cash leaving the business, so gated regardless of who prepared the memo.
  @Post(':id/refund')
  @Roles('admin', 'staff')
  @HttpCode(200)
  @ApiOperation({ summary: 'Refund the remaining credit balance to the customer (cash).' })
  refund(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    if (user.role === 'admin') return this.svc.refund(companyId, id, user.id);
    return this.approvals.createRequest(
      'credit_memo',
      { action: 'refund', creditMemoId: id },
      'Refund a credit memo balance in cash',
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
      { entity: 'credit_memo', targetId: id },
      'Void a credit memo',
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
