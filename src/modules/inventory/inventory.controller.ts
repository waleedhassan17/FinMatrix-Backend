import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UnsupportedMediaTypeException,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiBearerAuth, ApiBody, ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import { isUUID } from 'class-validator';
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
import { InventoryImagesService, UploadedImageFile } from './images/inventory-images.service';
import { ItemImageUrlsInterceptor } from './images/item-image-urls.interceptor';

const IMAGE_MIMES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_IMAGE_BYTES = Number(process.env.ITEM_IMAGE_MAX_SIZE_MB ?? 10) * 1024 * 1024;
/** One batch of photo URLs — a quotation has far fewer lines than this. */
const MAX_IMAGE_IDS = 200;

@ApiTags('Inventory')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@RequiresFeature('inventory') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
// Every item this controller returns, in whatever shape, leaves with signed
// imageUrl / thumbnailUrl — see the interceptor for why that lives here.
@UseInterceptors(ItemImageUrlsInterceptor)
@Controller('inventory')
export class InventoryController {
  constructor(
    private readonly svc: InventoryService,
    private readonly approvals: ApprovalRequestsService,
    private readonly images: InventoryImagesService,
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

  /**
   * Give an item its photo (replacing any it had). Any JPG/PNG/WEBP; the
   * server straightens, strips location data and resizes it. Staff as well as
   * the owner: a photo is catalogue data, like the name, and posts nothing.
   */
  @Post('items/:id/image')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Upload the item photo; returns the item with imageUrl/thumbnailUrl.' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['image'],
      properties: { image: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(
    FileInterceptor('image', {
      limits: { fileSize: MAX_IMAGE_BYTES },
      fileFilter: (_req, file, cb) => {
        if (!IMAGE_MIMES.includes(file.mimetype)) {
          cb(
            new UnsupportedMediaTypeException({
              code: 'IMAGE_UNSUPPORTED_TYPE',
              message: 'Item photos must be JPG, PNG or WEBP images.',
            }),
            false,
          );
          return;
        }
        cb(null, true);
      },
    }),
  )
  setImage(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @UploadedFile() file?: UploadedImageFile,
  ) {
    if (!file) {
      throw new BadRequestException({ code: 'IMAGE_REQUIRED', message: 'Choose a photo to upload.' });
    }
    return this.images.setImage(companyId, id, user.id, file);
  }

  @Delete('items/:id/image')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Remove the item photo; returns the item.' })
  removeImage(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.images.removeImage(companyId, id, user.id);
  }

  /**
   * Photo URLs for many items at once, keyed by item id — for quotation PDFs,
   * which hold document lines rather than items. `?ids=a,b,c`. Items without
   * a photo are absent from the answer.
   *
   * Not `items/images`: that would be read as `items/:id` and fail its UUID
   * check. And the map sits under `images`, never a top-level `data`, which
   * the response envelope would keep while dropping everything beside it.
   */
  @Get('item-images')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Signed photo URLs for up to 200 items (?ids=a,b,c).' })
  async itemImages(@CurrentCompany() companyId: string, @Query('ids') ids: string | undefined) {
    const list = [...new Set((ids ?? '').split(',').map((s) => s.trim()).filter(Boolean))];
    if (list.length > MAX_IMAGE_IDS || list.some((id) => !isUUID(id))) {
      throw new BadRequestException({
        code: 'INVALID_IDS',
        message: `ids must be up to ${MAX_IMAGE_IDS} comma-separated item ids.`,
      });
    }
    return { images: await this.images.imageUrlsFor(companyId, list) };
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
