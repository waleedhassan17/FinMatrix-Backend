import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Reconciliation } from './entities/reconciliation.entity';
import { GeneralLedgerEntry } from '../ledger/entities/general-ledger.entity';
import { Account } from '../accounts/entities/account.entity';
import { ReconciliationsService } from './reconciliations.service';
import { ReconciliationsController } from './reconciliations.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Reconciliation, GeneralLedgerEntry, Account]),
  ],
  providers: [ReconciliationsService],
  controllers: [ReconciliationsController],
  exports: [ReconciliationsService],
})
export class ReconciliationsModule {}
