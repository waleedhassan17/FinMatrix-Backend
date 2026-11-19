import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import {
  AuthenticatedUser,
  CurrentUser,
} from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { CompanyExportService } from './company-export.service';
import { CreateExportDto } from './dto/create-export.dto';

/**
 * Company backup: the owner asks for a ZIP of the whole company and gets a
 * signed link when it is ready. Owner only on every plan — staff never see
 * it in either app, and this controller refuses them.
 */
@ApiTags('Data portability')
@ApiBearerAuth()
@UseGuards(CompanyGuard, RolesGuard)
@Controller('data-portability/exports')
export class DataPortabilityController {
  constructor(private readonly exports: CompanyExportService) {}

  @Post()
  @HttpCode(202)
  @Roles('admin')
  @ApiOperation({
    summary: 'Queue a company backup (ZIP). Returns the job; poll until ready.',
  })
  create(
    @CurrentCompany() companyId: string,
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateExportDto,
  ) {
    return this.exports.request(companyId, user, dto.includeXlsx === true);
  }

  @Get()
  @Roles('admin')
  @ApiOperation({ summary: 'Backups of this company, newest first.' })
  list(@CurrentCompany() companyId: string) {
    return this.exports.list(companyId);
  }

  @Get(':id')
  @Roles('admin')
  @ApiOperation({ summary: 'One backup, with its error when it failed.' })
  get(
    @CurrentCompany() companyId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.exports.get(companyId, id);
  }
}
