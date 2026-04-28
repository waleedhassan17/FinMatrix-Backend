import {
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
import { InventoryApprovalsService } from './inventory-approvals.service';
import {
  ApproveInventoryUpdateRequestDto,
  ListInventoryUpdateRequestsQueryDto,
  RejectInventoryUpdateRequestDto,
} from './dto/inventory-approval.dto';

@ApiTags('Inventory Update Requests')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('inventory-update-requests')
export class InventoryUpdateRequestsController {
  constructor(private readonly svc: InventoryApprovalsService) {}

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
  @Post(':id/approve')
  @Roles('admin')
  @ApiOperation({ summary: 'Approve inventory update request (admin)' })
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
    const data = await this.svc.approve(companyId, id, dto, user.id);
    return { success: true, data };
  }

  /**
   * POST /api/v1/inventory-update-requests/:id/reject
   * Admin rejects → no inventory mutation.
   */
  @Post(':id/reject')
  @Roles('admin')
  @ApiOperation({ summary: 'Reject inventory update request (admin)' })
  @ApiParam({ name: 'id', type: 'string', format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Request rejected' })
  @ApiResponse({ status: 409, description: 'Request is not pending' })
  async reject(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectInventoryUpdateRequestDto,
  ) {
    const data = await this.svc.reject(companyId, id, dto, user.id);
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
    @Param('id', ParseUUIDPipe) id: string,
    @Res() res: Response,
  ) {
    const file = await this.svc.streamBillPhoto(companyId, id);
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    file.stream.pipe(res);
  }
}
