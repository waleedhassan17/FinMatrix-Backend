import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { LedgerService } from './ledger.service';
import { LedgerQueryDto } from './dto/ledger-query.dto';
import {
  ParsePaginationPipe,
  PaginationParams,
} from '../../common/pipes/parse-pagination.pipe';

@ApiTags('ledger')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard)
@Controller('ledger')
export class LedgerController {
  constructor(private readonly ledger: LedgerService) {}

  @Get()
  @ApiOperation({ summary: 'Paginated GL entries with totals and balance check.' })
  list(
    @CurrentCompany() companyId: string,
    @Query() query: LedgerQueryDto,
    @Query(ParsePaginationPipe) pagination: PaginationParams,
  ) {
    return this.ledger.list(companyId, query, pagination);
  }
}
