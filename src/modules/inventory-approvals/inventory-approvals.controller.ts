import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { InventoryApprovalsService } from './inventory-approvals.service';
import { CreateInventoryUpdateRequestDto, ReviewRequestDto } from './dto/inventory-approval.dto';

@ApiTags('Inventory Approvals')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('inventory-approvals')
export class InventoryApprovalsController {
  constructor(private readonly svc: InventoryApprovalsService) {}

  @Get()
  @Roles('admin', 'staff')
  list(
    @CurrentCompany() companyId: string,
    @Query('status') status: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.list(companyId, status, page, limit);
  }

  @Post()
  @Roles('delivery')
  create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateInventoryUpdateRequestDto,
  ) {
    return this.svc.create(companyId, dto);
  }

  @Get(':id')
  @Roles('admin', 'staff', 'delivery')
  get(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.getById(companyId, id);
  }

  @Patch(':id/review')
  @Roles('admin', 'staff')
  review(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewRequestDto,
  ) {
    return this.svc.review(companyId, id, dto, 'user-id');
  }
}
