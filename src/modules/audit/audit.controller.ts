import { Controller, Get, Param, ParseIntPipe, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { CompanyGuard } from '../../common/guards/company.guard';
import { AuditService } from './audit.service';

@ApiTags('Audit')
@ApiBearerAuth()
@UseGuards(CompanyGuard)
@Controller('audit')
export class AuditController {
  constructor(private readonly svc: AuditService) {}

  @Get()
  @Roles('admin')
  list(
    @CurrentCompany() companyId: string,
    @Query('module') module: string,
    @Query('resourceType') resourceType: string,
    @Query('resourceId') resourceId: string,
    @Query('userId') userId: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 50,
  ) {
    return this.svc.list(companyId, { module, resourceType, resourceId, userId }, page, limit);
  }

  @Get('summary')
  @Roles('admin')
  summary(@CurrentCompany() companyId: string) {
    return this.svc.summary(companyId);
  }

  @Get('resource/:type/:id')
  @Roles('admin')
  byResource(
    @CurrentCompany() companyId: string,
    @Param('type') resourceType: string,
    @Param('id') resourceId: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 50,
  ) {
    return this.svc.byResource(companyId, resourceType, resourceId, page, limit);
  }
}
