import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeneralLedgerEntry } from './entities/general-ledger.entity';
import { LedgerService } from './ledger.service';
import { LedgerController } from './ledger.controller';
import { PartyLedgerService } from './party-ledger.service';
import { PartyHistoryService } from './party-history.service';

/**
 * General Ledger browse / drill-down. LedgerService derives chronological
 * double-entry rows from posted documents (invoices, bills, payments) so the
 * ledger reflects real activity; the GeneralLedgerEntry entity stays registered
 * for auto-posting and "view account transactions" elsewhere.
 */
@Module({
  imports: [TypeOrmModule.forFeature([GeneralLedgerEntry])],
  controllers: [LedgerController],
  providers: [LedgerService, PartyLedgerService, PartyHistoryService],
  exports: [TypeOrmModule, LedgerService, PartyLedgerService, PartyHistoryService],
})
export class LedgerModule {}
