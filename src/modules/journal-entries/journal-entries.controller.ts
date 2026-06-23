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
import {
  CreateJournalEntryDto,
  ListJournalEntriesQueryDto,
  VoidJournalEntryDto,
} from './dto/journal-entry.dto';

@ApiTags('journal-entries')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('journal-entries')
export class JournalEntriesController {
  constructor(private readonly svc: JournalEntriesService) {}

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

  @Post()
  @Roles('admin')
  @ApiOperation({ summary: 'Create a manual journal entry (draft or posted).' })
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateJournalEntryDto,
  ) {
    return this.svc.create(companyId, user.id, dto);
  }

  @Post(':id/post')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Post a draft journal entry to the ledger.' })
  post(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.svc.post(companyId, id, user.id);
  }

  @Post(':id/void')
  @Roles('admin')
  @HttpCode(200)
  @ApiOperation({ summary: 'Void an entry (reverses it if already posted).' })
  void(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: VoidJournalEntryDto,
  ) {
    return this.svc.void(companyId, id, user.id, dto);
  }
}
