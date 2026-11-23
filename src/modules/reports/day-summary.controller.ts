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
  DAY_ENTRY_SORTS,
  DAY_ITEM_COMPARES,
  DayEntryFilter,
  DayEntrySort,
  DayItemCompare,
} from './day-summary.types';
import {
  isIsoDate,
  isoDayCount,
  MAX_ITEM_SHEET_DAYS,
} from './day-summary.util';

/** The longest search the Day Book accepts — a number or a name, not prose. */
const MAX_SEARCH = 100;

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
  @ApiOperation({
    summary: "The day's documents (Day Book): paged, searched and sorted",
  })
  @ApiQuery({ name: 'date', required: false })
  @ApiQuery({
    name: 'type',
    required: false,
    description: `${[...DAY_ENTRY_FILTERS, ...DAY_DOC_KINDS].join(' | ')}`,
  })
  @ApiQuery({ name: 'createdBy', required: false })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Document number or party name',
  })
  @ApiQuery({
    name: 'sort',
    required: false,
    description: DAY_ENTRY_SORTS.join(' | '),
  })
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
    @Query('q') q?: string,
    @Query('sort') sort?: string,
  ) {
    return this.svc.entries(companyId, user, {
      date: this.checkedDate(date),
      filter: this.checkedFilter(type),
      createdBy: createdBy || null,
      page: this.checkedInt('page', page, 1, 100000),
      limit: this.checkedInt('limit', limit, 1, 1000),
      q: this.checkedSearch(q),
      sort: this.checkedSort(sort),
    });
  }

  @Get('items')
  @Roles('admin', 'staff')
  @ApiOperation({
    summary:
      'Item-wise sales for a day or a range: sold, free, returned, net units and net sales per item',
  })
  @ApiQuery({
    name: 'date',
    required: false,
    description: 'One day, YYYY-MM-DD; default today',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: `Start of a range (with to), at most ${MAX_ITEM_SHEET_DAYS} days`,
  })
  @ApiQuery({ name: 'to', required: false, description: 'End of the range' })
  @ApiQuery({ name: 'createdBy', required: false })
  @ApiQuery({
    name: 'compare',
    required: false,
    description: DAY_ITEM_COMPARES.join(' | '),
  })
  items(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Query('date') date?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('createdBy') createdBy?: string,
    @Query('compare') compare?: string,
  ) {
    const range = this.checkedRange(date, from, to);
    return this.svc.items(companyId, user, {
      ...range,
      createdBy: createdBy || null,
      compare: this.checkedCompare(compare),
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

  /**
   * One day (`date`, or today) or a range (`from` and `to`, both given, in
   * order, at most a year).
   */
  private checkedRange(
    date?: string,
    from?: string,
    to?: string,
  ): { from?: string; to?: string } {
    if (!from && !to) {
      const day = this.checkedDate(date);
      return { from: day, to: day };
    }
    if (!from || !to) {
      throw new BadRequestException({
        code: 'INVALID_RANGE',
        message: 'from and to must be given together.',
      });
    }
    const start = this.checkedDate(from)!;
    const end = this.checkedDate(to)!;
    if (start > end) {
      throw new BadRequestException({
        code: 'INVALID_RANGE',
        message: 'from must be on or before to.',
      });
    }
    if (isoDayCount(start, end) > MAX_ITEM_SHEET_DAYS) {
      throw new BadRequestException({
        code: 'INVALID_RANGE',
        message: `A range can cover at most ${MAX_ITEM_SHEET_DAYS} days.`,
      });
    }
    return { from: start, to: end };
  }

  private checkedCompare(v?: string): DayItemCompare | null {
    if (v === undefined || v === '') return null;
    if (!(DAY_ITEM_COMPARES as readonly string[]).includes(v)) {
      throw new BadRequestException({
        code: 'INVALID_COMPARE',
        message: `compare must be one of: ${DAY_ITEM_COMPARES.join(', ')}.`,
      });
    }
    return v as DayItemCompare;
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

  private checkedSearch(v?: string): string | null {
    const q = (v ?? '').trim();
    if (!q) return null;
    if (q.length > MAX_SEARCH) {
      throw new BadRequestException({
        code: 'INVALID_SEARCH',
        message: `q must be at most ${MAX_SEARCH} characters.`,
      });
    }
    return q;
  }

  private checkedSort(v?: string): DayEntrySort {
    if (v === undefined || v === '') return 'newest';
    if (!(DAY_ENTRY_SORTS as readonly string[]).includes(v)) {
      throw new BadRequestException({
        code: 'INVALID_SORT',
        message: `sort must be one of: ${DAY_ENTRY_SORTS.join(', ')}.`,
      });
    }
    return v as DayEntrySort;
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
