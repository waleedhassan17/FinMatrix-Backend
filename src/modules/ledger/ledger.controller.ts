import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { LedgerService } from './ledger.service';

@ApiTags('ledger')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Chronological general ledger; filter by date range and account code.' })
  query(
    @CurrentCompany() companyId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('account') account?: string,
  ) {
    return this.ledger.query(companyId, startDate, endDate, account);
  }

  @Get('accounts')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Per-account balances roll-up (drill-down).' })
  accounts(
    @CurrentCompany() companyId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.ledger.accounts(companyId, startDate, endDate);
  }
}
