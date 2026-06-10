import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { JournalEntry } from './entities/journal-entry.entity';
import { JournalEntryLine } from './entities/journal-entry-line.entity';
import { Account } from '../accounts/entities/account.entity';
import { GeneralLedgerEntry } from '../ledger/entities/general-ledger.entity';
import { PostingService } from './posting.service';

/**
 * First Update (v1.0) scope: the manual Journal Entry screens/endpoints are
 * deferred to the Second Update. Auto-posting still runs in v1 — invoices,
 * bills and payments post their journal entries through PostingService, which
 * is the only thing this module exposes now. The JournalEntry/Line entities
 * remain registered so PostingService and the General Ledger keep working.
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
  providers: [PostingService],
  exports: [PostingService, TypeOrmModule],
})
export class JournalEntriesModule {}
