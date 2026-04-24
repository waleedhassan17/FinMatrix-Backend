import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import {
  CreateJournalEntryDto,
  ListJournalEntriesQueryDto,
  UpdateJournalEntryDto,
  VoidJournalEntryDto,
} from './dto/journal-entry.dto';
import { JournalEntriesService } from './journal-entries.service';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('journal-entries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('journal-entries')
export class JournalEntriesController {
  constructor(private readonly service: JournalEntriesService) {}

  @Get()
  @ApiOperation({ summary: 'List entries with filters and summary counts.' })
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListJournalEntriesQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.service.list(companyId, query, pagination);
  }

  @Get(':entryId')
  @ApiOperation({ summary: 'Full entry detail with lines.' })
  get(
    @CurrentCompany() companyId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ) {
    return this.service.getById(companyId, entryId);
  }

  @Post()
  @Roles('admin')
  @ApiOperation({ summary: 'Create a draft or posted journal entry.' })
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateJournalEntryDto,
  ) {
    return this.service.create(companyId, user.id, dto);
  }

  @Patch(':entryId')
  @Roles('admin')
  @ApiOperation({ summary: 'Update a draft entry. 400 CANNOT_EDIT_POSTED otherwise.' })
  update(
    @CurrentCompany() companyId: string,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: UpdateJournalEntryDto,
  ) {
    return this.service.update(companyId, entryId, dto);
  }

  @Post(':entryId/post')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Post a draft entry: updates balances + GL.' })
  post(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ) {
    return this.service.post(companyId, entryId, user.id);
  }

  @Post(':entryId/void')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Void: creates reversing entry and marks original void.' })
  void(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('entryId', ParseUUIDPipe) entryId: string,
    @Body() dto: VoidJournalEntryDto,
  ) {
    return this.service.voidEntry(companyId, entryId, user.id, dto);
  }

  @Post(':entryId/duplicate')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Copy as new draft with today\'s date.' })
  duplicate(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('entryId', ParseUUIDPipe) entryId: string,
  ) {
    return this.service.duplicate(companyId, entryId, user.id);
  }
}
