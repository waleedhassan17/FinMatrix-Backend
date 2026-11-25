import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  DefaultValuePipe,
  ParseIntPipe,
  BadRequestException,
} from '@nestjs/common';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { SuperAdminService } from './super-admin.service';
import { PlanTermsDto } from './dto/update-company-status.dto';
import {
  CurrentUser,
  AuthenticatedUser,
} from '../../common/decorators/current-user.decorator';

class RejectDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

class OptionalReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

class SuspendDto {
  @IsString()
  @MaxLength(500)
  reason!: string;
}

function guardSuperAdmin(user: AuthenticatedUser) {
  if (user.role !== 'super_admin') {
    throw new ForbiddenException('Super admin access required');
  }
}

/**
 * Granular Super-Admin company-review endpoints (Phase1.md contract):
 *   GET  /admin/companies?status=
 *   GET  /admin/companies/:id
 *   PATCH /admin/companies/:id/approve | /reject | /activate | /deactivate
 * Thin wrappers over SuperAdminService.updateCompanyStatus. Role-guarded
 * server-side — a company Admin or Delivery token gets 403.
 */
@Controller('admin/companies')
export class AdminCompaniesController {
  constructor(private readonly service: SuperAdminService) {}

  @Get()
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: string,
    @Query('isTrial') isTrial?: string,
    @Query('search') search?: string,
    @Query('isDemo') isDemo?: string,
  ) {
    guardSuperAdmin(user);
    return this.service.getAllCompanies(
      page,
      limit,
      status,
      SuperAdminService.parseTrialFilter(isTrial),
      search,
      SuperAdminService.parseTrialFilter(isDemo),
    );
  }

  @Get(':id')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    guardSuperAdmin(user);
    return this.service.getCompanyDetail(id);
  }

  /** Approve with { plan, startDate?, endDate } or { asTrial: true }. */
  @Patch(':id/approve')
  async approve(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() terms: PlanTermsDto,
  ) {
    guardSuperAdmin(user);
    return this.service.updateCompanyStatus(
      id,
      { ...(terms ?? {}), status: 'active' },
      user.id,
    );
  }

  @Patch(':id/reject')
  async reject(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectDto,
  ) {
    guardSuperAdmin(user);
    if (!dto?.reason)
      throw new BadRequestException('Rejection reason is required');
    return this.service.updateCompanyStatus(
      id,
      { status: 'rejected', rejectionReason: dto.reason },
      user.id,
    );
  }

  /** Reinstate a suspended company, or activate a plan (plan + end date). */
  @Patch(':id/activate')
  async activate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() terms: PlanTermsDto,
  ) {
    guardSuperAdmin(user);
    return this.service.updateCompanyStatus(
      id,
      { ...(terms ?? {}), status: 'active' },
      user.id,
    );
  }

  /** Suspend: every member is refused until reinstated. Reason required. */
  @Patch(':id/suspend')
  async suspend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: SuspendDto,
  ) {
    guardSuperAdmin(user);
    return this.service.suspendCompany(id, user.id, dto?.reason ?? '');
  }

  @Patch(':id/reinstate')
  async reinstate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    guardSuperAdmin(user);
    return this.service.reinstateCompany(id, user.id);
  }

  @Patch(':id/deactivate')
  async deactivate(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: OptionalReasonDto,
  ) {
    guardSuperAdmin(user);
    return this.service.updateCompanyStatus(
      id,
      { status: 'inactive', reason: dto?.reason },
      user.id,
    );
  }
}
