import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JournalEntry } from './entities/journal-entry.entity';
import { JournalEntryLine } from './entities/journal-entry-line.entity';
import { Account } from '../accounts/entities/account.entity';
import { GeneralLedgerEntry } from '../ledger/entities/general-ledger.entity';
import { PostingService } from './posting.service';
import { JournalEntriesService } from './journal-entries.service';
import { JournalEntriesController } from './journal-entries.controller';

/**
 * Manual General Journal module. PostingService is the shared posting engine
 * used by invoices, bills, payments and credit memos for auto-posting; the
 * controller + JournalEntriesService expose the manual journal-entry workflow
 * (create draft/posted, post, void-via-reversal) on top of it.
 */
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
  providers: [PostingService, JournalEntriesService],
  exports: [PostingService, TypeOrmModule],
})
export class JournalEntriesModule {}
