import {
  Body,
  Controller,
  Get,
  HttpCode,
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
import { SalesOrdersService } from './sales-orders.service';
import {
  CreateSalesOrderDto,
  FulfillOrderDto,
  ListSalesOrdersQueryDto,
} from './dto/sales-order.dto';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('sales-orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('sales-orders')
export class SalesOrdersController {
  constructor(private readonly service: SalesOrdersService) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListSalesOrdersQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.service.list(companyId, query, pagination);
  }

  @Get(':orderId')
  get(
    @CurrentCompany() companyId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.service.getById(companyId, orderId);
  }

  @Post()
  @Roles('admin')
  create(@CurrentCompany() companyId: string, @Body() dto: CreateSalesOrderDto) {
    return this.service.create(companyId, dto);
  }

  @Post(':orderId/fulfill')
  @Roles('admin')
  @HttpCode(200)
  fulfill(
    @CurrentCompany() companyId: string,
    @Param('orderId', ParseUUIDPipe) orderId: string,
    @Body() dto: FulfillOrderDto,
  ) {
    return this.service.fulfill(companyId, orderId, dto);
  }

  @Post(':orderId/create-invoice')
  @Roles('admin')
  @HttpCode(200)
  createInvoice(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('orderId', ParseUUIDPipe) orderId: string,
  ) {
    return this.service.createInvoice(companyId, user.id, orderId);
  }
}
