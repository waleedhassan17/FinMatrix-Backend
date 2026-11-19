import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { DaySummaryService } from './day-summary.service';
import {
  DAY_DOC_KINDS,
  DAY_ENTRY_FILTERS,
  DayEntryFilter,
} from './day-summary.types';
import { isIsoDate } from './day-summary.util';

export class DaySummaryScheduleDto {
  @ApiPropertyOptional({ description: 'Send the end-of-day digest.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Local hour 0–23. From 12 it covers that day; before 12, the day before.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(23)
  hour?: number;

  @ApiProperty({ required: false, description: 'Also email the digest.' })
  @IsOptional()
  @IsBoolean()
  email?: boolean;
}

/**
 * Day Summary: what the business did on one day — counts and totals of every
 * document type, money in and out by method, top customers and items, who
 * entered what, and the things an owner should look at (back-dated entries,
 * drafts, voids and deletions). Staff get the same page limited to the
 * documents they prepared themselves.
 */
@ApiTags('Reports')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@Controller('reports/day-summary')
export class DaySummaryController {
  constructor(private readonly svc: DaySummaryService) {}

  @Get()
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'One day of business at a glance' })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'YYYY-MM-DD; default today',
  })
  @ApiQuery({
    name: 'createdBy',
    required: false,
    description: 'Owner only: one member',
  })
  summary(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('date') date?: string,
    @Query('createdBy') createdBy?: string,
  ) {
    return this.svc.summary(companyId, user, {
      date: this.checkedDate(date),
      createdBy: createdBy || null,
    });
  }

  @Get('entries')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: "The day's documents, newest first (Day Book)" })
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({
    name: 'type',
    required: false,
    description: `${[...DAY_ENTRY_FILTERS, ...DAY_DOC_KINDS].join(' | ')}`,
  })
  @ApiQuery({ name: 'createdBy', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: '1–1000, default 50',
  })
  entries(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('date') date?: string,
    @Query('type') type?: string,
    @Query('createdBy') createdBy?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.entries(companyId, user, {
      date: this.checkedDate(date),
      filter: this.checkedFilter(type),
      createdBy: createdBy || null,
      page: this.checkedInt('page', page, 1, 100000),
      limit: this.checkedInt('limit', limit, 1, 1000),
    });
  }

  @Get('schedule')
  @Roles('admin')
  @ApiOperation({ summary: "The owner's end-of-day digest settings" })
  schedule(@CurrentCompany() companyId: string) {
    return this.svc.getSchedule(companyId);
  }

  @Put('schedule')
  @Roles('admin')
  @ApiOperation({ summary: 'Turn the end-of-day digest on or off, or move it' })
  setSchedule(
    @CurrentCompany() companyId: string,
    @Body() dto: DaySummaryScheduleDto,
  ) {
    return this.svc.setSchedule(companyId, dto);
  }

  // ── Query checks: a coded 400 rather than a Postgres error ───────────────

  private checkedDate(v?: string): string | undefined {
    if (v === undefined || v === '') return undefined;
    if (!isIsoDate(v)) {
      throw new BadRequestException({
        code: 'INVALID_DATE',
        message: 'date must be a real date in YYYY-MM-DD form.',
      });
    }
    return v;
  }

  private checkedFilter(v?: string): DayEntryFilter {
    if (v === undefined || v === '') return 'all';
    const allowed: readonly string[] = [...DAY_ENTRY_FILTERS, ...DAY_DOC_KINDS];
    if (!allowed.includes(v)) {
      throw new BadRequestException({
        code: 'INVALID_TYPE',
        message: `type must be one of: ${allowed.join(', ')}.`,
      });
    }
    return v as DayEntryFilter;
  }

  private checkedInt(
    name: string,
    v: string | undefined,
    min: number,
    max: number,
  ): number | undefined {
    if (v === undefined || v === '') return undefined;
    const n = Number(v);
    if (!/^\d{1,6}$/.test(v) || n < min || n > max) {
      throw new BadRequestException({
        code: 'INVALID_PAGING',
        message: `${name} must be a whole number from ${min} to ${max}.`,
      });
    }
    return n;
  }
}
