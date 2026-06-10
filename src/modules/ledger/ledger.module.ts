import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { GeneralLedgerEntry } from './entities/general-ledger.entity';

/**
 * First Update (v1.0) scope: the dedicated General Ledger browse/drill-down
 * endpoint is deferred to the Second Update, so the controller and service are
 * removed. The GeneralLedgerEntry entity stays registered because auto-posting
 * (PostingService) and "view account transactions" (Chart of Accounts) read
 * and write GL rows behind the scenes.
 */
@Module({
  imports: [TypeOrmModule.forFeature([GeneralLedgerEntry])],
  exports: [TypeOrmModule],
})
export class LedgerModule {}
