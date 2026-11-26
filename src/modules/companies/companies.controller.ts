import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { isUUID } from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { EmailVerifiedGuard } from '../../common/guards/email-verified.guard';
import { StartTrialDto } from './dto/start-trial.dto';
import {
  ActivationRequestDto,
  SubmitForApprovalDto,
} from './dto/signup-paths.dto';
import { CompaniesService } from './companies.service';
import { TrialService } from '../billing/trial/trial.service';
import {
  ClosePeriodDto,
  CreateCompanyDto,
  JoinCompanyDto,
  SelfSubscribeDto,
  UpdateCompanyDto,
} from './dto/create-company.dto';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';

@ApiTags('companies')
@ApiBearerAuth()
// EmailVerifiedGuard: every route here acts on a company, and none of it is for
// an owner who has not confirmed their address yet — least of all creating or
// submitting one. Sign-in used to be the only place this was checked, and the
// session /auth/signup returns never passed through it.
@UseGuards(JwtAuthGuard, EmailVerifiedGuard)
@Controller('companies')
export class CompaniesController {
  constructor(
    private readonly companies: CompaniesService,
    private readonly trials: TrialService,
  ) {}

  @Post()
  @ApiOperation({
    summary: 'Create a company and seed default chart of accounts.',
  })
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateCompanyDto,
  ) {
    return this.companies.create(user.id, dto);
  }

  @Post('join')
  @ApiOperation({ summary: 'Join an existing company via invite code.' })
  join(@CurrentUser() user: AuthenticatedUser, @Body() dto: JoinCompanyDto) {
    return this.companies.join(user.id, dto);
  }

  /**
   * Sign-up path A: "Start my free trial". An eligible owner's trial starts
   * at once (TRIAL_AUTO_APPROVE=true) — the response says `status: 'active'`
   * and the client goes straight to the dashboard. A risk signal (or
   * auto-approve off) holds it for a person: `status: 'pending_approval'`.
   * Not eligible → 409 TRIAL_NOT_ELIGIBLE {reason}, and nothing changes.
   *
   * companyId resolves the way `subscribe` does: body, then x-company-id
   * header, then the token (a freshly signed-up owner's token has none). The
   * service verifies the caller is that company's owner.
   *
   * Throttled per session: the global throttler runs before authentication,
   * so the bearer token (not req.user) is the tracker, with the IP as a
   * fallback. The unique claim indexes are the real abuse control; this only
   * stops a client hammering the route.
   */
  @Post('start-trial')
  @Throttle({
    default: {
      limit: 5,
      ttl: 900_000,
      getTracker: (req: Record<string, any>) =>
        (typeof req.headers?.authorization === 'string' &&
          req.headers.authorization) ||
        req.ip ||
        'anonymous',
    },
  })
  @ApiOperation({
    summary:
      'Start the free trial (owner only). Instant when eligible; held for review on a risk signal.',
  })
  startTrial(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: StartTrialDto,
    @Req() req: Request,
    @Headers('x-company-id') headerCompanyId?: string,
  ) {
    const companyId =
      dto.companyId ?? headerCompanyId ?? user.companyId ?? null;
    if (!companyId || !isUUID(companyId)) {
      throw new BadRequestException({
        code: 'COMPANY_REQUIRED',
        message: 'Set up your company before starting a free trial.',
      });
    }
    return this.trials.start(user.id, companyId, req.ip ?? null);
  }

  @Get(':companyId')
  @ApiOperation({ summary: 'Company detail. Must be a member.' })
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ) {
    return this.companies.getById(user.id, companyId);
  }

  @Patch(':companyId')
  @ApiOperation({ summary: 'Update company details. Admin only.' })
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: UpdateCompanyDto,
  ) {
    return this.companies.update(user.id, companyId, dto);
  }

  // Closing the books is a deliberate accounting act, not a field edit, so it
  // gets its own route — tier-gated by `periodClose`, which the feature map
  // has always declared but nothing enforced until now (audit gap G4).
  @Post(':companyId/period-close')
  @RequiresFeature('periodClose')
  @ApiOperation({
    summary:
      'Close the books through a date. Postings dated on or before it are rejected. Admin only.',
  })
  closePeriod(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: ClosePeriodDto,
  ) {
    return this.companies.closePeriod(user.id, companyId, dto.lockDate);
  }

  @Post(':companyId/period-reopen')
  @RequiresFeature('periodClose')
  @ApiOperation({ summary: 'Reopen closed books. Admin only.' })
  reopenPeriod(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ) {
    return this.companies.reopenPeriod(user.id, companyId);
  }

  @Get(':companyId/members')
  @ApiOperation({ summary: 'List all company members. Admin only.' })
  listMembers(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ) {
    return this.companies.listMembers(user.id, companyId);
  }

  @Delete(':companyId/members/:userId')
  @ApiOperation({ summary: 'Remove a member. Cannot remove self.' })
  removeMember(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Param('userId', ParseUUIDPipe) targetUserId: string,
  ) {
    return this.companies.removeMember(user.id, companyId, targetUserId);
  }

  @Post(':companyId/regenerate-code')
  @ApiOperation({ summary: 'Generate a new invite code. Admin only.' })
  regenerateCode(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ) {
    return this.companies.regenerateCode(user.id, companyId);
  }

  @Post('subscribe')
  @ApiOperation({
    summary: 'Select a subscription plan for your company (onboarding).',
  })
  subscribe(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: SelfSubscribeDto,
    @Headers('x-company-id') headerCompanyId?: string,
  ) {
    // A freshly-signed-up admin's JWT has no companyId yet, so accept it from
    // the body / x-company-id header, falling back to the token. selfSubscribe
    // verifies the caller is that company's admin.
    const companyId =
      dto.companyId ?? headerCompanyId ?? user.companyId ?? null;
    if (!companyId || !isUUID(companyId)) {
      throw new BadRequestException({
        code: 'COMPANY_REQUIRED',
        message: 'Set up your company before choosing a plan.',
      });
    }
    return this.companies.selfSubscribe(companyId, dto.planId, user.id);
  }

  /**
   * Whether "Start my free trial" will work for this company, and if not why
   * — so the setup screen shows path A disabled with the reason BEFORE the
   * owner presses it. The same rules the start itself applies.
   */
  @Get(':companyId/trial-eligibility')
  @ApiOperation({ summary: 'Can this company start the free trial? (owner)' })
  trialEligibility(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
  ) {
    return this.trials.eligibilityFor(user.id, companyId);
  }

  /**
   * Sign-up path B: "Request account approval". The company waits for a
   * super-admin, who approves it with a plan, a start and an end date (or as a
   * trial, if still eligible), or rejects it with a reason. The body is
   * optional: older clients send none.
   */
  @Post(':companyId/submit')
  @ApiOperation({
    summary:
      'Request account approval (path B): optional requested plan and note.',
  })
  submit(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: SubmitForApprovalDto,
  ) {
    return this.companies.submitForApproval(user.id, companyId, dto ?? {});
  }

  /**
   * "Request activation": the owner asks FinMatrix to switch a plan on — no
   * payment gateway. Available during a trial (converts it on approval),
   * after it ended, or after a plan expired. Allowed for a lapsed company, so
   * this controller carries no CompanyGuard.
   */
  @Post(':companyId/activation-request')
  @ApiOperation({ summary: 'Ask FinMatrix to activate a plan (owner).' })
  activationRequest(
    @CurrentUser() user: AuthenticatedUser,
    @Param('companyId', ParseUUIDPipe) companyId: string,
    @Body() dto: ActivationRequestDto,
  ) {
    return this.trials.requestActivation(user.id, companyId, dto ?? {});
  }
}
