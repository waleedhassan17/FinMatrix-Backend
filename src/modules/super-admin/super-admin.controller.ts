import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  Query,
  ParseUUIDPipe,
  ParseIntPipe,
  DefaultValuePipe,
  ForbiddenException,
} from '@nestjs/common';
import { IsString, IsNotEmpty, MinLength } from 'class-validator';
import { SuperAdminService } from './super-admin.service';
import { CreateSubscriptionPlanDto } from './dto/create-subscription-plan.dto';
import { UpdateCompanyStatusDto } from './dto/update-company-status.dto';
import { AssignSubscriptionDto } from './dto/assign-subscription.dto';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PublicRoute } from '../../common/decorators/public.decorator';

class SeedAdminDto {
  @IsString()
  @IsNotEmpty()
  masterKey!: string;

  @IsString()
  @IsNotEmpty()
  email!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @IsNotEmpty()
  displayName!: string;
}

function guardSuperAdmin(user: AuthenticatedUser) {
  if (user.role !== 'super_admin') {
    throw new ForbiddenException('Super admin access required');
  }
}

@Controller('super-admin')
export class SuperAdminController {
  constructor(private readonly service: SuperAdminService) {}

  // ─── Seed Super Admin (one-time setup) ──────────────────────────────────────

  @PublicRoute()
  @Post('seed')
  async seedAdmin(@Body() dto: SeedAdminDto) {
    const masterKey = process.env.SUPER_ADMIN_MASTER_KEY ?? 'finmatrix-super-secret-2024';
    if (dto.masterKey !== masterKey) {
      throw new ForbiddenException('Invalid master key');
    }
    return this.service.seedSuperAdmin(dto.email, dto.password, dto.displayName);
  }

  // ─── Platform Stats ──────────────────────────────────────────────────────────

  @Get('stats')
  async getPlatformStats(@CurrentUser() user: AuthenticatedUser) {
    guardSuperAdmin(user);
    return this.service.getPlatformStats();
  }

  // ─── Companies ───────────────────────────────────────────────────────────────

  @Get('companies')
  async getAllCompanies(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('status') status?: string,
  ) {
    guardSuperAdmin(user);
    return this.service.getAllCompanies(page, limit, status);
  }

  @Get('companies/:id')
  async getCompanyDetail(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    guardSuperAdmin(user);
    return this.service.getCompanyDetail(id);
  }

  @Patch('companies/:id/status')
  async updateCompanyStatus(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCompanyStatusDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    guardSuperAdmin(user);
    return this.service.updateCompanyStatus(id, dto, user.id);
  }

  // ─── Public Plans (for signup subscription-select screen) ───────────────────

  @Get('plans/public')
  @PublicRoute()
  async getPublicPlans() {
    return this.service.getSubscriptionPlans();
  }

  // ─── Subscription Plans ──────────────────────────────────────────────────────

  @Get('plans')
  async getPlans(@CurrentUser() user: AuthenticatedUser) {
    guardSuperAdmin(user);
    return this.service.getSubscriptionPlans();
  }

  @Post('plans')
  async createPlan(
    @Body() dto: CreateSubscriptionPlanDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    guardSuperAdmin(user);
    return this.service.createSubscriptionPlan(dto);
  }

  @Patch('plans/:id')
  async updatePlan(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: Partial<CreateSubscriptionPlanDto>,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    guardSuperAdmin(user);
    return this.service.updateSubscriptionPlan(id, dto);
  }

  @Delete('plans/:id')
  async deletePlan(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    guardSuperAdmin(user);
    return this.service.deleteSubscriptionPlan(id);
  }

  // ─── Subscriptions ───────────────────────────────────────────────────────────

  @Get('subscriptions')
  async getAllSubscriptions(
    @CurrentUser() user: AuthenticatedUser,
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
  ) {
    guardSuperAdmin(user);
    return this.service.getAllSubscriptions(page, limit);
  }

  @Post('subscriptions')
  async assignSubscription(
    @Body() dto: AssignSubscriptionDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    guardSuperAdmin(user);
    return this.service.assignSubscription(dto, user.id);
  }
}
