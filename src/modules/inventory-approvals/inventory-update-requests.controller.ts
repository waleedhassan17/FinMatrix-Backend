import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { InventoryApprovalsService } from './inventory-approvals.service';
import {
  ApproveInventoryUpdateRequestDto,
  ListInventoryUpdateRequestsQueryDto,
  RejectInventoryUpdateRequestDto,
  UndoInventoryUpdateRequestDto,
} from './dto/inventory-approval.dto';
import { ApprovalRequestsService } from '../approvals/approval-requests.service';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';

@ApiTags('Inventory Update Requests')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@RequiresFeature('delivery') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
@Controller('inventory-update-requests')
export class InventoryUpdateRequestsController {
  constructor(
    private readonly svc: InventoryApprovalsService,
    private readonly approvals: ApprovalRequestsService,
  ) {}

  /**
   * GET /api/v1/inventory-update-requests
   * Paginated list with full request + nested changes[] + proof block.
   */
  @Get()
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'List inventory update requests (admin)' })
  @ApiQuery({ name: 'status', required: false, enum: ['pending', 'approved', 'rejected', 'all'] })
  @ApiQuery({ name: 'page', required: false, type: Number })
  @ApiQuery({ name: 'pageSize', required: false, type: Number })
  @ApiResponse({
    status: 200,
    description: 'Paginated list of inventory update requests',
  })
  async list(
    @CurrentCompany() companyId: string,
    @Query() query: ListInventoryUpdateRequestsQueryDto,
  ) {
    const page = Number(query.page) || 1;
    const pageSize = Number(query.pageSize) || 20;
    const data = await this.svc.listFormatted(companyId, query.status, page, pageSize);
    return { success: true, data };
  }

  /**
   * GET /api/v1/inventory-update-requests/:id
   * Single request detail. Accessible to admin or the owning DP.
   */
  @Get(':id')
  @Roles('admin', 'staff', 'delivery')
  @ApiOperation({ summary: 'Get a single inventory update request' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Request detail with changes and proof' })
  @ApiResponse({ status: 404, description: 'Request not found' })
  async getOne(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.svc.getOneFormatted(companyId, id, user.id, user.role);
    return { success: true, data };
  }

  /**
   * POST /api/v1/inventory-update-requests/:id/approve
   * Admin approves → mutates real inventory.
   */
  /**
   * The posting moment: revenue and COGS post here — Dr A/R / Cr Sales / Cr
   * Tax, then Dr COGS / Cr Goods in Transit. That is the largest ledger event
   * in the product, so signing it is the OWNER'S alone. Staff prepare and
   * watch; they see the pending request and a "Waiting for Admin Approval"
   * badge where the Approve button used to be.
   *
   * PATCH /inventory-approvals/:id/review is the other door into this same
   * method and gates identically (it branches on action, because rejecting
   * stays with staff). Widen one without the other and the gate is decorative.
   *
   * The reviewer's role is recorded on the request either way.
   */
  @Post(':id/approve')
  @Roles('admin')
  @ApiOperation({ summary: 'Approve inventory update request (owner only)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Request approved and inventory synced' })
  @ApiResponse({ status: 409, description: 'Request is not pending' })
  @ApiResponse({ status: 422, description: 'Negative stock would result' })
  async approve(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApproveInventoryUpdateRequestDto,
  ) {
    const data = await this.svc.approve(companyId, id, dto, {
      id: user.id,
      role: user.role,
    });
    return { success: true, data };
  }

  /**
   * POST /api/v1/inventory-update-requests/:id/reject
   * Admin rejects → no inventory mutation.
   */
  /**
   * Rider failed — stock goes back on the shelf and no sale is recognised
   * (Table B row 6). Staff may do this directly: nothing is being corrected,
   * because nothing was ever sold.
   *
   * Deliberately NOT gated alongside approve. Rejecting posts no revenue, and
   * making it owner-only would strand a failed delivery's stock in Goods in
   * Transit until the owner next logs in — a real operational cost for no
   * control gained.
   */
  @Post(':id/reject')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Reject inventory update request (owner or staff)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Request rejected' })
  @ApiResponse({ status: 409, description: 'Request is not pending' })
  async reject(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectInventoryUpdateRequestDto,
  ) {
    const data = await this.svc.reject(companyId, id, dto, {
      id: user.id,
      role: user.role,
    });
    return { success: true, data };
  }

  /**
   * POST /api/v1/inventory-update-requests/:id/undo
   * Admin undoes a previously approved request — reverses inventory changes
   * and sets the request status back to 'rejected'.
   */
  /**
   * Undo reverses recognised revenue, so it is the owner's call. Staff are not
   * refused outright — they file a request carrying a REASON, and the owner
   * decides (Table B row 7, as amended).
   *
   * The precondition is checked twice on purpose. assertUndoable runs here, at
   * request time, because undoApproval refuses outright once a delivery is
   * ledger-committed — and filing a request that can never be approved would
   * strand it in the inbox forever. It runs again inside undoApproval at
   * approval time, because the delivery can change in between.
   */
  @Post(':id/undo')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Undo an approved delivery (owner direct, staff by request)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Approval undone, or a request filed' })
  @ApiResponse({ status: 409, description: 'Request is not approved, or already committed' })
  async undoApproval(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UndoInventoryUpdateRequestDto,
  ) {
    if (user.role === 'admin') {
      const data = await this.svc.undoApproval(companyId, id, user.id);
      return { success: true, data };
    }

    if (!dto?.reason?.trim()) {
      throw new BadRequestException({
        code: 'REASON_REQUIRED',
        message:
          'Say why this delivery should be undone — the owner needs the reason to decide.',
      });
    }
    await this.svc.assertUndoable(companyId, id);

    const data = await this.approvals.createRequest(
      'delivery_undo',
      { requestId: id },
      'Undo an approved delivery',
      user,
      companyId,
      dto.reason.trim(),
    );
    return { success: true, data };
  }

  /**
   * GET /api/v1/inventory-update-requests/:id/credit-memo-draft
   *
   * The credit memo that would reverse this delivery, filled in from the
   * delivery's own figures. Reading a draft posts nothing, so both roles may
   * ask — what differs is what happens when they submit it, which the ordinary
   * (gated) credit-memo endpoint decides.
   */
  @Get(':id/credit-memo-draft')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Draft credit memo reversing an approved delivery' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Draft credit memo' })
  @ApiResponse({ status: 409, description: 'Not approved, or never posted a sale' })
  async creditMemoDraft(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    const data = await this.svc.buildCreditMemoDraft(companyId, id);
    return { success: true, data };
  }

  /**
   * GET /api/v1/inventory-update-requests/:id/bill-photo
   * Streams the stored bill photo image (auth-gated).
   */
  @Get(':id/bill-photo')
  @Roles('admin', 'staff', 'delivery')
  @ApiOperation({ summary: 'Stream the bill photo image' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Image stream' })
  @ApiResponse({ status: 404, description: 'Photo not found' })
  async streamBillPhoto(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const file = await this.svc.streamBillPhoto(companyId, id, { id: user.id, role: user.role });
    res.setHeader('Content-Type', file.mimeType ?? 'image/jpeg');
    if (file.size != null) res.setHeader('Content-Length', String(file.size));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    file.stream.pipe(res);
  }
}
