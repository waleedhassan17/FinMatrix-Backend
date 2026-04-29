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
import { PurchaseOrdersService } from './purchase-orders.service';
import {
  CreateBillFromPoDto,
  CreatePurchaseOrderDto,
  ListPurchaseOrdersQueryDto,
  ReceivePurchaseOrderDto,
} from './dto/purchase-order.dto';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('purchase-orders')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('purchase-orders')
export class PurchaseOrdersController {
  constructor(private readonly service: PurchaseOrdersService) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListPurchaseOrdersQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.service.list(companyId, query, pagination);
  }

  @Get(':poId')
  get(
    @CurrentCompany() companyId: string,
    @Param('poId', ParseUUIDPipe) poId: string,
  ) {
    return this.service.getById(companyId, poId);
  }

  @Post()
  @Roles('admin')
  create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreatePurchaseOrderDto,
  ) {
    return this.service.create(companyId, dto);
  }

  @Post(':poId/receive')
  @Roles('admin')
  @HttpCode(200)
  receive(
    @CurrentCompany() companyId: string,
    @Param('poId', ParseUUIDPipe) poId: string,
    @Body() dto: ReceivePurchaseOrderDto,
  ) {
    return this.service.receive(companyId, poId, dto);
  }

  @Post(':poId/create-bill')
  @Roles('admin')
  @HttpCode(200)
  createBill(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('poId', ParseUUIDPipe) poId: string,
    @Body() dto: CreateBillFromPoDto,
  ) {
    return this.service.createBill(companyId, user.id, poId, dto);
  }

  @Patch(':poId')
  @Roles('admin')
  update(
    @CurrentCompany() companyId: string,
    @Param('poId', ParseUUIDPipe) poId: string,
    @Body() dto: CreatePurchaseOrderDto,
  ) {
    return this.service.update(companyId, poId, dto);
  }

  @Delete(':poId')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @Param('poId', ParseUUIDPipe) poId: string,
  ) {
    return this.service.delete(companyId, poId);
  }

  @Patch(':poId/status')
  @Roles('admin')
  @HttpCode(200)
  status(
    @CurrentCompany() companyId: string,
    @Param('poId', ParseUUIDPipe) poId: string,
    @Body('status') status: string,
  ) {
    return this.service.updateStatus(companyId, poId, status as any);
  }
}
