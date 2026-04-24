import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BankAccount } from './entities/bank-account.entity';
import { BankTransaction } from './entities/bank-transaction.entity';
import { Reconciliation } from './entities/reconciliation.entity';
import { BankingService } from './banking.service';
import { BankingController } from './banking.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([BankAccount, BankTransaction, Reconciliation]),
  ],
  providers: [BankingService],
  controllers: [BankingController],
  exports: [BankingService],
})
export class BankingModule {}
