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
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { InventoryService } from './inventory.service';
import {
  CreateInventoryItemDto,
  UpdateInventoryItemDto,
  InventoryItemQueryDto,
  AdjustQuantityDto,
  SetOpeningStockDto,
  CreateStockTransferDto,
  CreatePhysicalCountDto,
  MovementQueryDto,
} from './dto/inventory.dto';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';
import { ApprovalRequestsService } from '../approvals/approval-requests.service';

@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@RequiresFeature('inventory') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly svc: InventoryService,
    private readonly approvals: ApprovalRequestsService,
  ) {}

  // Items
  @Get('items')
  @Roles('admin', 'staff')
  listItems(
    @CurrentCompany() companyId: string,
    @Query() query: InventoryItemQueryDto,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
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

  // Opening stock is admin-only and one-time: it posts straight to equity, so
  // it is not something staff should be able to do repeatedly. Corrections go
  // through adjust() below, which records a reason and can be reversed.
  //
  // Deliberately NOT widened to staff with the other "stock receipts" in
  // Table A: an opening balance is not a receipt. The receipt staff perform is
  // POST /purchase-orders/:poId/receive (Dr Inventory / Cr GRNI), which is
  // widened; this one credits Owner's Equity.
  @Post('items/:id/opening-stock')
  @Roles('admin')
  setOpeningStock(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SetOpeningStockDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.setOpeningStock(companyId, id, dto, user.id);
  }

  /**
   * Adjustments and write-offs correct the ledger, so they are gated: the
   * owner posts immediately, staff file a request that posts nothing until it
   * is approved (Table A, "money out & corrections").
   *
   * The gate sits HERE, at the controller boundary, and never inside
   * InventoryService — service-to-service posting (delivery dispatch, the
   * credit memo a rejected prepaid delivery raises) must keep working
   * untouched, and would deadlock if the service itself filed requests.
   */
  @Post('items/:id/adjust')
  @Roles('admin', 'staff')
  async adjust(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AdjustQuantityDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (user.role === 'admin') return this.svc.adjust(companyId, dto, user.id);

    // Capture the stock the requester was looking at. An adjustment names an
    // ABSOLUTE target, but the owner may approve it days later against a very
    // different shelf — see InventoryService.adjustFromApprovedRequest, which
    // uses this to tell "I counted 80" (stale if stock moved) apart from
    // "20 broke" (still true whatever moved).
    const item = await this.svc.getItem(companyId, id);
    const observedQty = String(item.quantityOnHand);
    const delta = Number(dto.newQty) - Number(observedQty);

    return this.approvals.createRequest(
      'adjustment',
      { ...dto, itemId: id, observedQty },
      // The summary states the INTENTION, so the owner approves an act rather
      // than a bare number whose meaning depends on stock they cannot see.
      dto.reason === 'physical_count'
        ? `Physical count: ${item.name} counted at ${dto.newQty} (was ${observedQty})`
        : `${delta < 0 ? 'Write off' : 'Add'} ${Math.abs(delta)} × ${item.name} — ${dto.reason}`,
      user,
      companyId,
    );
  }

  @Get('items/:id/movements')
  @Roles('admin', 'staff')
  itemMovements(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.svc.itemMovements(companyId, id, page, limit);
  }

  // Transfers
  // G7: adjustments previously had no correction path — a mistake could only
  // be papered over with a second adjustment.
  /**
   * Reversing a posted adjustment is a correction, so Table A puts it in the
   * same column as every other void: the owner does it, staff ask. It was
   * refused outright for staff, which is safe but is not the row as written.
   */
  @Post('adjustments/:id/reverse')
  @Roles('admin', 'staff')
  reverseAdjustment(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    if (user.role === 'admin') {
      return this.svc.reverseAdjustment(companyId, id, user.id);
    }
    return this.approvals.createRequest(
      'void',
      { entity: 'adjustment', targetId: id },
      'Reverse a posted inventory adjustment',
      user,
      companyId,
    );
  }

  @Post('transfers')
  @Roles('admin', 'staff')
  createTransfer(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateStockTransferDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.createTransfer(companyId, dto, user.id);
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
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.createCount(companyId, dto, user.id);
  }

  // Movements
  @Get('movements')
  @Roles('admin', 'staff')
  listMovements(
    @CurrentCompany() companyId: string,
    @Query() query: MovementQueryDto,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.svc.listMovements(companyId, query, page, limit);
  }
}
