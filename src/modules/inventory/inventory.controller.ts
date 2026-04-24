import {
  Body,
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { InventoryService } from './inventory.service';
import {
  CreateInventoryItemDto,
  UpdateInventoryItemDto,
  InventoryItemQueryDto,
  AdjustQuantityDto,
  CreateStockTransferDto,
  CreatePhysicalCountDto,
  MovementQueryDto,
} from './dto/inventory.dto';

@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('inventory')
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  // Items
  @Get('items')
  @Roles('admin', 'staff')
  listItems(
    @CurrentCompany() companyId: string,
    @Query() query: InventoryItemQueryDto,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.listItems(companyId, query, page, limit);
  }

  @Post('items')
  @Roles('admin', 'staff')
  createItem(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateInventoryItemDto,
  ) {
    return this.svc.createItem(companyId, dto);
  }

  @Get('items/:id')
  @Roles('admin', 'staff')
  getItem(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.getItem(companyId, id);
  }

  @Patch('items/:id')
  @Roles('admin', 'staff')
  updateItem(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateInventoryItemDto,
  ) {
    return this.svc.updateItem(companyId, id, dto);
  }

  @Patch('items/:id/toggle')
  @Roles('admin')
  toggleItem(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.toggleItem(companyId, id);
  }

  @Post('items/:id/adjust')
  @Roles('admin', 'staff')
  adjust(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustQuantityDto,
  ) {
    return this.svc.adjust(companyId, dto, 'user-id');
  }

  @Get('items/:id/movements')
  @Roles('admin', 'staff')
  itemMovements(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.itemMovements(companyId, id, page, limit);
  }

  // Transfers
  @Post('transfers')
  @Roles('admin', 'staff')
  createTransfer(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateStockTransferDto,
  ) {
    return this.svc.createTransfer(companyId, dto, 'user-id');
  }

  @Patch('transfers/:id/complete')
  @Roles('admin', 'staff')
  completeTransfer(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.completeTransfer(companyId, id);
  }

  // Physical Counts
  @Post('physical-counts')
  @Roles('admin', 'staff')
  createCount(
    @CurrentCompany() companyId: string,
    @Body() dto: CreatePhysicalCountDto,
  ) {
    return this.svc.createCount(companyId, dto, 'user-id');
  }

  // Movements
  @Get('movements')
  @Roles('admin', 'staff')
  listMovements(
    @CurrentCompany() companyId: string,
    @Query() query: MovementQueryDto,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.listMovements(companyId, query, page, limit);
  }
}
