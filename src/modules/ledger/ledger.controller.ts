import { BadRequestException, Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CompanyGuard } from '../../common/guards/company.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentCompany } from '../../common/decorators/current-company.decorator';
import { LedgerService } from './ledger.service';
import { PartyLedgerService } from './party-ledger.service';
import { LedgerPartyType } from './party-ledger.sql';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The party view's inputs, refused in words rather than as a SQL cast error.
 * The account view has always taken its dates unchecked; it is left as it is.
 */
function partyArgs(type?: string, startDate?: string, endDate?: string, partyId?: string) {
  if (type !== 'customer' && type !== 'vendor') {
    throw new BadRequestException({
      code: 'INVALID_LEDGER_PARTY',
      message: 'party must be "customer" or "vendor".',
    });
  }
  for (const [name, value] of [['startDate', startDate], ['endDate', endDate]] as const) {
    if (value && !ISO_DATE.test(value)) {
      throw new BadRequestException({ code: 'INVALID_DATE', message: `${name} must be a date (YYYY-MM-DD).` });
    }
  }
  if (partyId && !UUID.test(partyId)) {
    throw new BadRequestException({ code: 'INVALID_PARTY_ID', message: 'partyId must be a customer or vendor id.' });
  }
  return { type: type as LedgerPartyType, partyId: partyId || undefined };
}

@ApiTags('ledger')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, CompanyGuard, RolesGuard)
@Controller('ledger')
export class LedgerController {
  constructor(
    private readonly ledger: LedgerService,
    private readonly parties: PartyLedgerService,
  ) {}

  /**
   * The general ledger. With `party`, the same ledger read by customer or
   * vendor: one party's postings on its control accounts (`partyId`), or every
   * party's — the way an account code narrows it to one account.
   */
  @Get()
  @Roles('admin', 'staff')
  @ApiOperation({
    summary:
      'Chronological general ledger; filter by date range and account code, or by party=customer|vendor (+ partyId).',
  })
  query(
    @CurrentCompany() companyId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
    @Query('account') account?: string,
    @Query('party') party?: string,
    @Query('partyId') partyId?: string,
  ) {
    if (party !== undefined && party !== '') {
      const args = partyArgs(party, startDate, endDate, partyId);
      return this.parties.ledger(companyId, args.type, startDate, endDate, args.partyId);
    }
    return this.ledger.query(companyId, startDate, endDate, account);
  }

  /** Every customer or vendor with its figures for the period — the picker's list. */
  @Get('parties')
  @Roles('admin', 'staff')
  @ApiOperation({ summary: 'Per-party roll-up for the general ledger picker (type=customer|vendor).' })
  partyList(
    @CurrentCompany() companyId: string,
    @Query('type') type?: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    const args = partyArgs(type, startDate, endDate);
    return this.parties.parties(companyId, args.type, startDate, endDate);
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
