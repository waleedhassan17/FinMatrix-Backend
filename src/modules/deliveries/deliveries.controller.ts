import {
  Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { DeliveriesService } from './deliveries.service';
import {
  CreateDeliveryDto,
  UpdateDeliveryDto,
  DeliveryStatusUpdateDto,
  DeliveryQueryDto,
  DeliveryIssueDto,
  CaptureSignatureDto,
  ConfirmDeliveryDto,
} from './dto/delivery.dto';

@ApiTags('Deliveries')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('deliveries')
export class DeliveriesController {
  constructor(private readonly svc: DeliveriesService) {}

  @Get()
  @Roles('admin', 'staff')
  list(
    @CurrentCompany() companyId: string,
    @Query() query: DeliveryQueryDto,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.list(companyId, query, page, limit);
  }

  @Post()
  @Roles('admin', 'staff')
  create(
    @CurrentCompany() companyId: string,
    @Body() dto: CreateDeliveryDto,
  ) {
    return this.svc.create(companyId, dto, 'user-id');
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
  ) {
    return this.svc.update(companyId, id, dto);
  }

  @Post(':id/auto-assign')
  @Roles('admin', 'staff')
  autoAssign(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.autoAssign(companyId, id);
  }

  @Patch(':id/status')
  @Roles('admin', 'staff', 'delivery')
  updateStatus(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliveryStatusUpdateDto,
  ) {
    return this.svc.updateStatus(companyId, id, dto, 'user-id');
  }

  @Get(':id/history')
  @Roles('admin', 'staff', 'delivery')
  history(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.getHistory(companyId, id, page, limit);
  }

  @Post(':id/issues')
  @Roles('delivery')
  reportIssue(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeliveryIssueDto,
  ) {
    return this.svc.reportIssue(companyId, id, dto, 'user-id');
  }

  @Get(':id/issues')
  @Roles('admin', 'staff', 'delivery')
  issues(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.listIssues(companyId, id, page, limit);
  }

  @Post('assign')
  @Roles('admin', 'staff')
  assign(
    @CurrentCompany() companyId: string,
    @Body() dto: { deliveryIds: string[]; personnelId: string },
  ) {
    return this.svc.assignDeliveries(companyId, dto.deliveryIds, dto.personnelId);
  }

  @Get('my/assigned')
  @Roles('delivery')
  myDeliveries(
    @CurrentCompany() companyId: string,
    @Query('personnelId') personnelId: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.myDeliveries(companyId, personnelId, page, limit);
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
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.myHistory(companyId, user.id, page, limit);
  }

  @Post(':id/signature')
  @Roles('delivery')
  captureSignature(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CaptureSignatureDto,
  ) {
    return this.svc.captureSignature(companyId, id, dto);
  }

  @Post(':id/confirm')
  @Roles('delivery')
  confirmDelivery(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ConfirmDeliveryDto,
  ) {
    return this.svc.confirmDelivery(companyId, id, dto, user.id);
  }
}
