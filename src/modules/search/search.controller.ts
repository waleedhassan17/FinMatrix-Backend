import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { SearchService } from './search.service';

@ApiTags('search')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('search')
export class SearchController {
  constructor(private readonly svc: SearchService) {}

  @Get()
  @Roles('admin', 'staff', 'delivery')
  search(
    @CurrentCompany() companyId: string,
    @Query('q') q: string,
    @Query('entities') entities: string,
  ) {
    return this.svc.search(companyId, q, entities);
  }
}
