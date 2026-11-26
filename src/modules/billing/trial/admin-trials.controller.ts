import {
  BadRequestException,
  Body,
  Controller,
  DefaultValuePipe,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../../common/decorators/current-user.decorator';
import { assertSuperAdmin } from '../../../common/guards/super-admin.util';
import { TrialService } from './trial.service';
import {
  TRIAL_ADMIN_VIEWS,
  TrialAdminService,
  type TrialAdminView,
} from './trial-admin.service';

class ReasonDto {
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

class ExtendTrialDto extends ReasonDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(30)
  days!: number;
}

/**
 * Super-admin trial operations. Every action is audited in
 * platform_audit_events by TrialService.
 */
@ApiTags('Admin — trials')
@ApiBearerAuth()
@Controller('admin')
export class AdminTrialsController {
  constructor(
    private readonly trials: TrialService,
    private readonly reads: TrialAdminService,
  ) {}

  @Get('trials')
  @ApiOperation({
    summary:
      'Trials & approvals: view = active | held | approvals | activations | ended',
  })
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Query('view') view = 'active',
    @Query('page', new DefaultValuePipe(1), ParseIntPipe) page: number,
    @Query('limit', new DefaultValuePipe(20), ParseIntPipe) limit: number,
    @Query('search') search?: string,
    @Query('endingWithinDays') endingWithinDays?: string,
  ) {
    assertSuperAdmin(user);
    if (!TRIAL_ADMIN_VIEWS.includes(view as TrialAdminView)) {
      throw new BadRequestException({
        code: 'INVALID_VIEW',
        message: `view must be one of ${TRIAL_ADMIN_VIEWS.join(', ')}`,
      });
    }
    const within = endingWithinDays ? Number(endingWithinDays) : undefined;
    return this.reads.list({
      view: view as TrialAdminView,
      page,
      limit,
      search,
      endingWithinDays:
        within && Number.isInteger(within) && within > 0 ? within : undefined,
    });
  }

  @Get('trials/counts')
  counts(@CurrentUser() user: AuthenticatedUser) {
    assertSuperAdmin(user);
    return this.reads.counts();
  }

  @Get('companies/:id/trial-claims')
  @ApiOperation({ summary: 'Trial-claim history of a company and its owner.' })
  claims(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    assertSuperAdmin(user);
    return this.reads.claimHistory(id);
  }

  @Get('companies/:id/trial-eligibility')
  @ApiOperation({
    summary: 'Would "approve as a trial" work for this company?',
  })
  eligibility(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    assertSuperAdmin(user);
    return this.trials.adminEligibility(id);
  }

  @Post('companies/:id/extend-trial')
  @ApiOperation({ summary: 'Extend a trial by 1–30 days (audited).' })
  extend(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ExtendTrialDto,
  ) {
    assertSuperAdmin(user);
    return this.trials.extend(id, user.id, dto.days, dto.reason);
  }

  @Post('companies/:id/end-trial')
  @ApiOperation({ summary: 'End a trial early (abuse), with a reason.' })
  end(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ) {
    assertSuperAdmin(user);
    return this.trials.endEarly(id, user.id, dto.reason);
  }

  @Post('companies/:id/grant-trial')
  @ApiOperation({
    summary:
      'Grant a trial to an otherwise ineligible company (override, audited).',
  })
  grant(
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReasonDto,
  ) {
    assertSuperAdmin(user);
    return this.trials.startForAdmin(id, user.id, 'grant', dto.reason);
  }
}
