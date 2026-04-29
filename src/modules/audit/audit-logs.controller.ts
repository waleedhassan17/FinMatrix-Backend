import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { AuditService } from './audit.service';

@ApiTags('audit-logs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('audit-logs')
export class AuditLogsController {
  constructor(private readonly svc: AuditService) {}

  @Get()
  @Roles('admin', 'staff')
  list(
    @CurrentCompany() companyId: string,
    @Query('entity') entity: string,
    @Query('entityId') entityId: string,
    @Query('action') action: string,
    @Query('userId') userId: string,
    @Query('page', ParseIntPipe) page = 1,
    @Query('limit', ParseIntPipe) limit = 20,
  ) {
    return this.svc.list(companyId, { module: entity, resourceType: entity, resourceId: entityId, userId }, page, limit);
  }

  @Get('summary')
  @Roles('admin', 'staff')
  summary(@CurrentCompany() companyId: string) {
    return this.svc.summary(companyId);
  }
}
