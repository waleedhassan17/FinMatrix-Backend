import {
  Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { AuthenticatedUser, CurrentUser } from '../../common/decorators/current-user.decorator';
import { SalesOrdersService } from './sales-orders.service';
import {
  ConvertSalesOrderDto, CreateSalesOrderDto, FulfillSalesOrderDto, ListSalesOrdersQueryDto, UpdateSalesOrderDto,
} from './dto/sales-order.dto';
import { ParsePaginationPipe, PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';

@ApiTags('sales-orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@RequiresFeature('salesOrders') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
// Financial data: company staff only — the delivery role must never read
// or write here (handler-level @Roles overrides where narrower).
@Roles('admin', 'staff')
@Controller('sales-orders')
export class SalesOrdersController {
  constructor(private readonly salesOrders: SalesOrdersService) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListSalesOrdersQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.salesOrders.list(companyId, query, pagination);
  }

  @Get(':orderId')
  get(@CurrentCompany() companyId: string, @Param('orderId', ParseUUIDPipe) id: string) {
    return this.salesOrders.getById(companyId, id);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateSalesOrderDto,
  ) {
    return this.salesOrders.create(companyId, user.id, dto);
  }

  @Patch(':orderId')
  @Roles('admin')
  update(
    @CurrentCompany() companyId: string,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: UpdateSalesOrderDto,
  ) {
    return this.salesOrders.update(companyId, id, dto);
  }

  @Post(':orderId/fulfill')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Record fulfillment quantities; recomputes open/partial/fulfilled.' })
  fulfill(
    @CurrentCompany() companyId: string,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: FulfillSalesOrderDto,
  ) {
    return this.salesOrders.fulfill(companyId, id, dto);
  }

  @Post(':orderId/convert-to-invoice')
  @Roles('admin')
  @HttpCode(201)
  @ApiOperation({ summary: 'Invoice a fulfilled sales order.' })
  convertToInvoice(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) id: string,
    @Body() dto: ConvertSalesOrderDto,
  ) {
    return this.salesOrders.convertToInvoice(companyId, user.id, id, dto);
  }

  @Post(':orderId/cancel')
  @Roles('admin')
  @HttpCode(200)
  cancel(@CurrentCompany() companyId: string, @Param('orderId', ParseUUIDPipe) id: string) {
    return this.salesOrders.cancel(companyId, id);
  }

  @Delete(':orderId')
  @Roles('admin')
  remove(@CurrentCompany() companyId: string, @Param('orderId', ParseUUIDPipe) id: string) {
    return this.salesOrders.delete(companyId, id);
  }
}
