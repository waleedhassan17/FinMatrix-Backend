import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JournalEntry } from './entities/journal-entry.entity';
import { JournalEntryLine } from './entities/journal-entry-line.entity';
import { Account } from '../accounts/entities/account.entity';
import { GeneralLedgerEntry } from '../ledger/entities/general-ledger.entity';
import { JournalEntriesService } from './journal-entries.service';
import { JournalEntriesController } from './journal-entries.controller';
import { PostingService } from './posting.service';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      JournalEntry,
      JournalEntryLine,
      Account,
      GeneralLedgerEntry,
    ]),
  ],
  controllers: [JournalEntriesController],
  providers: [JournalEntriesService, PostingService],
  exports: [JournalEntriesService, PostingService, TypeOrmModule],
})
export class JournalEntriesModule {}
