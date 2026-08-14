import {
  Controller,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../modules/auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../guards/company.guard';
import { RolesGuard } from '../guards/roles.guard';
import { Roles } from '../decorators/roles.decorator';
import { CurrentCompany } from '../decorators/current-company.decorator';
import { RequiresFeature } from '../features/requires-feature.decorator';
import { FinancialAuditService, ListAuditQuery } from './financial-audit.service';

@ApiTags('audit-trail')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@RequiresFeature('auditLog') // tier gate (FinMatrix.md) — small_business gets 403
// The audit trail exposes every financial document's before/after state:
// admins only, and never the delivery role.
@Roles('admin')
@Controller('audit-trail')
export class AuditTrailController {
  constructor(private readonly audit: FinancialAuditService) {}

  @Get()
  list(
    @CurrentCompany() companyId: string,
    @Query() query: ListAuditQuery,
    @Query('page', new ParseIntPipe({ optional: true })) page = 1,
    @Query('limit', new ParseIntPipe({ optional: true })) limit = 50,
  ) {
    return this.audit.list(companyId, query, page, Math.min(limit, 200));
  }

  @Get(':resourceType/:resourceId')
  forResource(
    @CurrentCompany() companyId: string,
    @Param('resourceType') resourceType: string,
    @Param('resourceId', ParseUUIDPipe) resourceId: string,
  ) {
    return this.audit.forResource(companyId, resourceType, resourceId);
  }
}
