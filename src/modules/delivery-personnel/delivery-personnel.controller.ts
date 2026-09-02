import {
  Body, Controller, Get, Param, ParseIntPipe, ParseUUIDPipe, Patch, Post, Query, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { DeliveryPersonnelService } from './delivery-personnel.service';
import { CreatePersonnelDto, UpdatePersonnelDto, UpdateLocationDto } from './dto/delivery-personnel.dto';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';

@ApiTags('Delivery Personnel')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@RequiresFeature('delivery') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
@Controller('delivery-personnel')
export class DeliveryPersonnelController {
  constructor(private readonly svc: DeliveryPersonnelService) {}

  @Get()
  @Roles('admin', 'staff')
  list(
    @CurrentCompany() companyId: string,
    @Query('status') status: string,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 20,
  ) {
    return this.svc.list(companyId, page, limit, status);
  }

  // Staff run day-to-day warehouse operations, and onboarding a rider is one
  // of them: the owner should not be the bottleneck for putting someone on a
  // route. Both roles are custodians of the credentials they issue.
  @Post()
  @Roles('admin', 'staff')
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreatePersonnelDto,
  ) {
    return this.svc.create(companyId, dto, user.id);
  }

  @Patch('location')
  @Roles('delivery')
  updateLocation(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateLocationDto,
  ) {
    return this.svc.updateLocation(companyId, user.id, dto);
  }

  @Get(':userId/location')
  @Roles('admin', 'staff')
  getLocation(
    @CurrentCompany() companyId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.svc.getLocation(companyId, userId);
  }

  @Get(':userId')
  @Roles('admin', 'staff', 'delivery')
  get(
    @CurrentCompany() companyId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.svc.getById(companyId, userId);
  }

  @Patch(':userId')
  @Roles('admin', 'staff')
  update(
    @CurrentCompany() companyId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @Body() dto: UpdatePersonnelDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.update(companyId, userId, dto, user.id);
  }

  @Patch(':userId/availability')
  @Roles('admin', 'staff', 'delivery')
  toggle(
    @CurrentCompany() companyId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
  ) {
    return this.svc.toggleAvailability(companyId, userId);
  }

  /**
   * Re-issue the rider's password and return it once, to be passed on. The
   * only recovery path for a rider: the account has no inbox, so there is no
   * self-service reset.
   */
  @Post(':userId/reset-password')
  @Roles('admin', 'staff')
  resetPassword(
    @CurrentCompany() companyId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.resetPassword(companyId, userId, user.id);
  }

  /** Show the stored credentials again. Audited on every read. */
  @Get(':userId/credential')
  @Roles('admin', 'staff')
  revealCredential(
    @CurrentCompany() companyId: string,
    @Param('userId', ParseUUIDPipe) userId: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    return this.svc.revealCredential(companyId, userId, user.id);
  }
}
