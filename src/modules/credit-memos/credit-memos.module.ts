import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CreditMemo } from './entities/credit-memo.entity';
import { CreditMemoLine } from './entities/credit-memo-line.entity';
import { CreditMemoApplication } from './entities/credit-memo-application.entity';
import { Customer } from '../customers/entities/customer.entity';
import { CreditMemosService } from './credit-memos.service';
import { CreditMemosController } from './credit-memos.controller';
import { JournalEntriesModule } from '../journal-entries/journal-entries.module';
import { AccountsModule } from '../accounts/accounts.module';
import { InvoicesModule } from '../invoices/invoices.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      CreditMemo,
      CreditMemoLine,
      CreditMemoApplication,
      Customer,
    ]),
    JournalEntriesModule,
    AccountsModule,
    InvoicesModule,
  ],
  controllers: [CreditMemosController],
  providers: [CreditMemosService],
})
export class CreditMemosModule {}
