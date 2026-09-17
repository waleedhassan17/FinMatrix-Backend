import {
  Body, Controller, Delete, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { DeliveriesService, requestedAdvance } from './deliveries.service';
import { ApprovalRequestsService } from '../approvals/approval-requests.service';
import { MONEY_TOLERANCE } from '../../common/utils/money.util';
import {
  CreateDeliveryDto,
  UpdateDeliveryDto,
  DeliveryStatusUpdateDto,
  DeliveryQueryDto,
  DeliveryIssueDto,
  ConfirmDeliveryDto,
} from './dto/delivery.dto';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';
import { CreditOverrideDto, creditOverrideFrom } from '../../common/validation/credit-override.dto';

@ApiTags('Deliveries')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@RequiresFeature('delivery') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
@Controller('deliveries')
export class DeliveriesController {
  constructor(
    private readonly svc: DeliveriesService,
    private readonly approvals: ApprovalRequestsService,
  ) {}

  @Get()
  @Roles('admin', 'staff', 'delivery')
  list(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query() query: DeliveryQueryDto,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.svc.list(companyId, query, page, limit, user);
  }

  /**
   * Create a delivery. Direct for both roles — except a delivery the customer
   * has paid for in advance (fully or in part) created by staff.
   *
   * The advance is cash in, and a staff member's cash receipt already waits on
   * the owner (payments.controller). Letting it in through a delivery would be
   * the same money without the signature, so a staff member's advance
   * delivery is filed as a request and NOTHING exists — no delivery, no stock
   * movement, no receipt — until the owner approves; the dispatcher then runs
   * this same create. The owner creates it directly, receipt and all.
   */
  @Post()
  @Roles('admin', 'staff')
  create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateDeliveryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    const { gross, advance } = requestedAdvance(dto);
    if (user.role !== 'admin' && advance.greaterThan(MONEY_TOLERANCE)) {
      const customer = dto.customerName ? ` for ${dto.customerName}` : '';
      return this.approvals.createRequest(
        'delivery_advance',
        dto as unknown as Record<string, unknown>,
        `Delivery${customer} of ${gross.toFixed(2)}, ${advance.toFixed(2)} paid in advance`,
        user,
        companyId,
      );
    }
    return this.svc.create(companyId, dto, user.id, creditOverrideFrom(dto.creditOverride, user));
  }

  @Get('my/assigned')
  @Roles('delivery')
  myDeliveries(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.svc.myDeliveries(companyId, user.id, page, limit);
  }

  @Get('my/dashboard')
  @Roles('delivery')
  myDashboard(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.myDashboard(companyId, user.id);
  }

  @Get('my/history')
  @Roles('delivery')
  myHistory(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.svc.myHistory(companyId, user.id, page, limit);
  }

  @Get('map-data')
  @Roles('admin', 'staff')
  getMapData(@CurrentCompany() companyId: string) {
    return this.svc.getMapData(companyId);
  }

  @Post('geocode-pending')
  @Roles('admin', 'staff')
  geocodePending(@CurrentCompany() companyId: string) {
    return this.svc.geocodePending(companyId);
  }

  @Get(':id/location-history')
  @Roles('admin', 'staff')
  locationHistory(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.getLocationHistory(companyId, id);
  }

  @Get(':id')
  @Roles('admin', 'staff', 'delivery')
  get(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.getById(companyId, id);
  }

  @Patch(':id')
  @Roles('admin', 'staff')
  update(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateDeliveryDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.update(companyId, id, dto, user.id, creditOverrideFrom(dto.creditOverride, user));
  }

  /**
   * Discard a delivery that was created but never dispatched. Admin-only, and
   * refused once anything has been committed to the books — a dispatched
   * delivery is cancelled (which restocks and reverses Goods in Transit),
   * never deleted.
   */
  @Delete(':id')
  @Roles('admin')
  remove(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.remove(companyId, id);
  }

  @Post(':id/auto-assign')
  @Roles('admin', 'staff')
  autoAssign(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() body: { creditOverride?: CreditOverrideDto } = {},
  ) {
    return this.svc.autoAssign(companyId, id, user.id, creditOverrideFrom(body?.creditOverride, user));
  }

  @Patch(':id/status')
  @Roles('admin', 'staff', 'delivery')
  updateStatus(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliveryStatusUpdateDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.updateStatus(companyId, id, dto, user.id, user.role);
  }

  @Get(':id/history')
  @Roles('admin', 'staff', 'delivery')
  history(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.svc.getHistory(companyId, id, page, limit);
  }

  @Post(':id/issues')
  @Roles('delivery')
  reportIssue(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliveryIssueDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.reportIssue(companyId, id, dto, user.id);
  }

  @Get(':id/issues')
  @Roles('admin', 'staff', 'delivery')
  issues(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.svc.listIssues(companyId, id, page, limit);
  }

  @Post('assign')
  @Roles('admin', 'staff')
  assign(
    @CurrentCompany() companyId: string,
    @Body() dto: { deliveryIds: string[]; personnelId: string; creditOverride?: CreditOverrideDto },
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.assignDeliveries(
      companyId,
      dto.deliveryIds,
      dto.personnelId,
      user.id,
      creditOverrideFrom(dto.creditOverride, user),
    );
  }

  @Post(':id/confirm')
  @Roles('delivery')
  confirmDelivery(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmDeliveryDto,
  ) {
    return this.svc.confirmDelivery(companyId, id, dto, user.id, user.role);
  }
}
