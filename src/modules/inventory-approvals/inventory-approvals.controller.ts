import { Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { InventoryApprovalsService } from './inventory-approvals.service';
import { CreateInventoryUpdateRequestDto, ReviewRequestDto } from './dto/inventory-approval.dto';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';

@ApiTags('Inventory Approvals')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@RequiresFeature('delivery') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
@Controller('inventory-approvals')
export class InventoryApprovalsController {
  constructor(private readonly svc: InventoryApprovalsService) {}

  @Get()
  @Roles('admin', 'staff')
  async list(
    @CurrentCompany() companyId: string,
    @Query('status') status: string,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    const items = await this.svc.list(companyId, status, page, limit);
    return { success: true, data: { requests: items } };
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

  // A second door into the same code as /inventory-update-requests/:id/approve,
  // so its roles must stay in step with that route or the stricter guard can
  // simply be walked around. Both now allow staff: signing off a delivery is
  // the day-to-day close of one, not a correction (Table B row 4). The
  // reviewer's role travels through so it is recorded on the request either way.
  @Patch(':id/review')
  @Roles('admin', 'staff')
  async review(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewRequestDto,
  ) {
    const result = await this.svc.review(companyId, id, dto, {
      id: user.id,
      role: user.role,
    });
    return { success: true, data: { request: result } };
  }
}
