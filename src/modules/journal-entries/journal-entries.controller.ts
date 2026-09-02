import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
import { JournalEntriesService } from './journal-entries.service';
import { ApprovalRequestsService } from '../approvals/approval-requests.service';
import {
  CreateJournalEntryDto,
  ListJournalEntriesQueryDto,
  VoidJournalEntryDto,
} from './dto/journal-entry.dto';
import { RequiresFeature } from '../../common/features/requires-feature.decorator';

@ApiTags('journal-entries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@RequiresFeature('journalEntries') // tier gate (FinMatrix.md) — 403 when the company's type lacks this feature
@Controller('journal-entries')
export class JournalEntriesController {
  constructor(
    private readonly svc: JournalEntriesService,
    private readonly approvals: ApprovalRequestsService,
  ) {}

  @Get()
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'List manual journal entries (the General Journal).' })
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListJournalEntriesQueryDto,
  ) {
    return this.svc.list(companyId, query);
  }

  @Get(':id')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Get a single journal entry with its lines.' })
  get(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.getById(companyId, id);
  }

  /**
   * A manual journal writes the ledger directly, so staff may draft one only
   * as a request (Table A). Approving replays it here as a POSTED entry.
   */
  @Post()
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Create a manual journal entry (draft or posted).' })
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateJournalEntryDto,
  ) {
    if (user.role === 'admin') return this.svc.create(companyId, user.id, dto);
    return this.approvals.createRequest(
      'journal',
      dto as unknown as Record<string, unknown>,
      `Manual journal ${dto.date}: ${dto.memo ?? `${dto.lines?.length ?? 0} lines`}`,
      user,
      companyId,
    );
  }

  @Post(':id/post')
  @Roles('admin', 'staff')
  @HttpCode(200)
  @ApiOperation({ summary: 'Post a draft journal entry to the ledger.' })
  post(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    if (user.role === 'admin') return this.svc.post(companyId, id, user.id);
    return this.approvals.createRequest(
      'journal',
      { draftEntryId: id },
      'Post a draft journal entry',
      user,
      companyId,
    );
  }

  @Post(':id/void')
  @Roles('admin', 'staff')
  @HttpCode(200)
  @ApiOperation({ summary: 'Void an entry (reverses it if already posted).' })
  void(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidJournalEntryDto,
  ) {
    if (user.role === 'admin') return this.svc.void(companyId, id, user.id, dto);
    return this.approvals.createRequest(
      'void',
      { entity: 'journal', targetId: id, ...dto },
      `Void journal entry — ${dto.reason ?? 'no reason given'}`,
      user,
      companyId,
    );
  }
}
