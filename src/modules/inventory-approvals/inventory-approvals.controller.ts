import { Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
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

  // A second door into the same code as /inventory-update-requests/:id/approve
  // and /reject, so its roles must stay in step with those routes or the
  // stricter guard can simply be walked around. This is the door the app uses.
  //
  // The two actions part company here, so the gate cannot live in @Roles:
  //   approved — posts the sale (Dr A/R / Cr Sales, Dr COGS / Cr Goods in
  //              Transit). The largest ledger event in the product, so it is
  //              the owner's signature. Staff get a 403, matching
  //              @Roles('admin') on /inventory-update-requests/:id/approve.
  //   rejected — posts no revenue; it restocks and reverses Goods in Transit
  //              (Table B row 6). Staff keep it, so a failed delivery's stock
  //              is not stranded in transit until the owner next logs in.
  //
  // The reviewer's role travels through either way, so the request records the
  // authority that actually signed it.
  @Patch(':id/review')
  @Roles('admin', 'staff')
  async review(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReviewRequestDto,
  ) {
    if (dto.action === 'approved' && user.role !== 'admin') {
      throw new ForbiddenException({
        code: 'FORBIDDEN',
        message:
          'Only the owner can sign off a delivery — approving it recognises the sale. You can still reject one.',
      });
    }

    const result = await this.svc.review(companyId, id, dto, {
      id: user.id,
      role: user.role,
    });
    return { success: true, data: { request: result } };
  }
}
