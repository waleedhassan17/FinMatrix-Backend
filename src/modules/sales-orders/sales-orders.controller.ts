import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { SalesOrdersService } from './sales-orders.service';
import {
  CloseSalesOrderDto,
  ConvertSalesOrderDto,
  CreateSalesOrderDto,
  FulfillSalesOrderDto,
  ListSalesOrdersQueryDto,
  UpdateSalesOrderDto,
} from './dto/sales-order.dto';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';
import { ApprovalRequestsService } from '../approvals/approval-requests.service';
import { creditOverrideFrom } from '../../common/validation/credit-override.dto';

@ApiTags('sales-orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@RequiresFeature('salesOrders') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
// Financial data: company staff only — the delivery role must never read
// or write here (handler-level @Roles overrides where narrower).
@Roles('admin', 'staff')
@Controller('sales-orders')
export class SalesOrdersController {
  constructor(
    private readonly salesOrders: SalesOrdersService,
    private readonly approvals: ApprovalRequestsService,
  ) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListSalesOrdersQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.salesOrders.list(companyId, query, pagination);
  }

  @Get(':orderId/invoice-preview')
  @ApiOperation({
    summary:
      'What the next invoice from this order would bill (shipped, not yet invoiced). Posts nothing.',
  })
  invoicePreview(
    @CurrentCompany() companyId: string,
    @Param('orderId', ParseUUIDPipe) id: string,
  ) {
    return this.salesOrders.invoicePreview(companyId, id);
  }

  @Get(':orderId')
  get(
    @CurrentCompany() companyId: string,
    @Param('orderId', ParseUUIDPipe) id: string,
  ) {
    return this.salesOrders.getDetail(companyId, id);
  }

  @Post()
  @Roles('admin', 'staff')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSalesOrderDto,
  ) {
    return this.salesOrders.create(companyId, user.id, dto);
  }

  @Patch(':orderId')
  @Roles('admin', 'staff')
  update(
    @CurrentCompany() companyId: string,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSalesOrderDto,
  ) {
    return this.salesOrders.update(companyId, id, dto);
  }

  @Post(':orderId/fulfill')
  @Roles('admin', 'staff')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Record fulfillment quantities; recomputes open/partial/fulfilled.',
  })
  fulfill(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: FulfillSalesOrderDto,
  ) {
    return this.salesOrders.fulfill(
      companyId,
      id,
      dto,
      creditOverrideFrom(dto.creditOverride, user),
    );
  }

  @Post(':orderId/convert-to-invoice')
  @Roles('admin', 'staff')
  @HttpCode(201)
  @ApiOperation({
    summary:
      'Invoice what has shipped and is not billed yet (an order with nothing shipped is shipped and invoiced in full). closeRemaining closes the rest.',
  })
  async convertToInvoice(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: ConvertSalesOrderDto,
  ) {
    if (user.role === 'admin') {
      return this.salesOrders.convertToInvoice(
        companyId,
        user.id,
        id,
        dto,
        creditOverrideFrom(dto.creditOverride, user),
      );
    }
    // Converting posts an invoice, and staff invoices are signed off by the
    // owner (invoices.controller). This route used to let staff skip that.
    const { orderNumber, payload } = await this.salesOrders.conversionPayload(
      companyId,
      id,
      dto,
    );
    const what =
      payload.mode === 'shipped'
        ? `${payload.lines.length} line(s) of shipped goods`
        : `${payload.lines.length} line(s)`;
    return this.approvals.createRequest(
      'invoice',
      payload as unknown as Record<string, unknown>,
      `Invoice from sales order ${orderNumber}: ${what}, total ${Number(payload.expectedTotal).toFixed(2)}, due ${payload.dueDate}` +
        (payload.closeRemaining ? '; closes the rest of the order' : ''),
      user,
      companyId,
    );
  }

  @Post(':orderId/close')
  @Roles('admin', 'staff')
  @HttpCode(200)
  @ApiOperation({
    summary:
      'Short-close: what has not shipped will not ship. Refused while shipped goods are uninvoiced. Posts nothing.',
  })
  close(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: CloseSalesOrderDto,
  ) {
    return this.salesOrders.close(companyId, user.id, id, dto);
  }

  @Post(':orderId/reopen')
  @Roles('admin', 'staff')
  @HttpCode(200)
  @ApiOperation({ summary: 'Reopen a closed sales order.' })
  reopen(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) id: string,
  ) {
    return this.salesOrders.reopen(companyId, user.id, id);
  }

  @Post(':orderId/cancel')
  @Roles('admin', 'staff')
  @HttpCode(200)
  cancel(
    @CurrentCompany() companyId: string,
    @Param('orderId', ParseUUIDPipe) id: string,
  ) {
    return this.salesOrders.cancel(companyId, id);
  }

  @Delete(':orderId')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @Param('orderId', ParseUUIDPipe) id: string,
  ) {
    return this.salesOrders.delete(companyId, id);
  }
}
