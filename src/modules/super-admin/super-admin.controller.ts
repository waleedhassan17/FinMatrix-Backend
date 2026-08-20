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
import { FeatureOverrideDto } from './dto/feature-override.dto';
import { AssignSubscriptionDto } from './dto/assign-subscription.dto';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';
import { PublicRoute } from '../../common/decorators/public.decorator';
import { Throttle } from '@nestjs/throttler';
import { createHash, timingSafeEqual } from 'node:crypto';

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

/**
 * Constant-time string comparison. Hash first so the lengths always match:
 * timingSafeEqual throws on unequal lengths, and that throw would itself leak
 * the key's length.
 */
function timingSafeEquals(a: string, b: string): boolean {
  const ha = createHash('sha256').update(String(a ?? '')).digest();
  const hb = createHash('sha256').update(String(b ?? '')).digest();
  return timingSafeEqual(ha, hb);
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

  /**
   * ONE-TIME platform bootstrap. This is the only unauthenticated route that
   * can mint privilege, so it is deliberately hard to reach:
   *
   *  1. It used to fall back to a hardcoded master key when the env var was
   *     unset — and the env var WAS unset in production, so a string published
   *     in this repository was a working key to create a super admin over the
   *     internet. A default that ships in source is not a secret. There is no
   *     fallback now: no key configured means the route is closed.
   *  2. Once any super admin exists the route is closed permanently, so the
   *     window is a fresh install and nothing else.
   *  3. The key is compared in constant time; a byte-by-byte compare on a
   *     public endpoint leaks it.
   *  4. Every rejection returns the SAME message, so a caller cannot learn
   *     whether the key was wrong, the platform was already bootstrapped, or
   *     bootstrapping is disabled entirely.
   */
  @PublicRoute()
  @Throttle({ default: { limit: 5, ttl: 60_000 } })
  @Post('seed')
  async seedAdmin(@Body() dto: SeedAdminDto) {
    const closed = new ForbiddenException('Super admin bootstrap is not available.');

    const masterKey = process.env.SUPER_ADMIN_MASTER_KEY;
    if (!masterKey || masterKey.length < 32) throw closed;
    if (await this.service.superAdminExists()) throw closed;
    if (!timingSafeEquals(dto.masterKey, masterKey)) throw closed;

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

  /**
   * KILL SWITCH (FinMatrix.md SAFETY §4): flip all_features_unlocked (and
   * optionally companyType / the large-org inventory toggle) per company in
   * seconds — no deploy. FeatureGuard checks the unlock BEFORE any type/plan
   * logic, so this instantly restores full access if gating misbehaves.
   */
  @Patch('companies/:id/feature-override')
  async updateFeatureOverride(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: FeatureOverrideDto,
    @CurrentUser() user: AuthenticatedUser,
  ) {
    guardSuperAdmin(user);
    return this.service.updateFeatureOverride(id, dto, user.id);
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
