import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, In, Repository } from 'typeorm';
import { JournalEntry } from './entities/journal-entry.entity';
import { JournalEntryLine } from './entities/journal-entry-line.entity';
import { Account } from '../accounts/entities/account.entity';
import { PostingService } from './posting.service';
import {
  CreateJournalEntryDto,
  ListJournalEntriesQueryDto,
  VoidJournalEntryDto,
} from './dto/journal-entry.dto';
import { toDecimal } from '../../common/utils/money.util';
import { assertNotReconciled } from '../reconciliations/reconciliations.util';

/**
 * HTTP-facing service for the manual General Journal.
 *
 * The heavy lifting (validation, balance updates, GL rows) lives in
 * PostingService — this service owns the transaction boundary, query/read
 * shaping, and the void-via-reversing-entry workflow that mirrors how
 * invoices/bills void their posted journal entries.
 */
@Injectable()
export class JournalEntriesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly posting: PostingService,
    @InjectRepository(JournalEntry)
    private readonly repo: Repository<JournalEntry>,
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
  ) {}

  /** Chronological list of manual journal entries with light filtering. */
  async list(companyId: string, query: ListJournalEntriesQueryDto) {
    const qb = this.repo
      .createQueryBuilder('e')
      .where('e.companyId = :companyId', { companyId });

    if (query.status) qb.andWhere('e.status = :status', { status: query.status });
    if (query.startDate) qb.andWhere('e.date >= :startDate', { startDate: query.startDate });
    if (query.endDate) qb.andWhere('e.date <= :endDate', { endDate: query.endDate });
    if (query.search) {
      qb.andWhere(
        new Brackets((w) => {
          w.where('e.reference ILIKE :s', { s: `%${query.search}%` }).orWhere(
            'e.memo ILIKE :s',
            { s: `%${query.search}%` },
          );
        }),
      );
    }

    qb.orderBy('e.date', 'DESC').addOrderBy('e.createdAt', 'DESC');
    const entries = await qb.getMany();
    return { entries };
  }

  /** Single entry with its lines enriched with account number/name. */
  async getById(companyId: string, id: string) {
    const entry = await this.repo.findOne({
      where: { id, companyId },
      relations: { lines: true },
    });
    if (!entry) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Journal entry not found',
      });
    }
    return this.enrich(companyId, entry);
  }

  async create(companyId: string, userId: string, dto: CreateJournalEntryDto) {
    const entry = await this.dataSource.transaction((manager) =>
      this.posting.createEntry(manager, {
        companyId,
        createdBy: userId,
        date: dto.date,
        memo: dto.memo ?? null,
        status: dto.status ?? 'draft',
        lines: dto.lines.map((l, i) => ({
          accountId: l.accountId,
          description: l.description ?? null,
          debit: l.debit,
          credit: l.credit,
          lineOrder: l.lineOrder ?? i,
        })),
        sourceType: 'journal_entry',
      }),
    );
    return this.getById(companyId, entry.id);
  }

  /** Promote a draft entry to posted (writes balances + GL rows). */
  async post(companyId: string, id: string, userId: string) {
    const entry = await this.dataSource.transaction((manager) =>
      this.posting.postDraft(manager, companyId, id, userId),
    );
    return this.getById(companyId, entry.id);
  }

  /**
   * Void an entry. Posted entries are reversed with a balancing entry
   * (debit/credit swapped) so the ledger stays auditable; drafts are simply
   * marked void with no GL impact.
   */
  async void(
    companyId: string,
    id: string,
    userId: string,
    dto: VoidJournalEntryDto,
  ) {
    await this.dataSource.transaction(async (manager) => {
      const entry = await manager.findOne(JournalEntry, {
        where: { id, companyId },
        relations: { lines: true },
      });
      if (!entry) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Journal entry not found',
        });
      }
      if (entry.status === 'void') {
        throw new BadRequestException({
          code: 'ALREADY_VOID',
          message: 'Journal entry is already void',
        });
      }

      // Bank-reconciliation lock: a posted entry whose GL rows are part of a
      // completed reconciliation must not be voided — the reversal would not
      // touch the reconciled row, but QuickBooks semantics (and our beginning
      // balance sanity) require an explicit admin undo of the reconciliation
      // before altering the underlying transaction.
      await assertNotReconciled(manager, companyId, [entry.id], 'journal entry');

      if (entry.status === 'posted') {
        // Reversing entry: swap debit and credit on every line.
        await this.posting.createEntry(manager, {
          companyId,
          createdBy: userId,
          date: new Date().toISOString().slice(0, 10),
          memo: `Void ${entry.reference}: ${dto.reason}`,
          status: 'posted',
          lines: entry.lines
            .slice()
            .sort((a, b) => a.lineOrder - b.lineOrder)
            .map((l, i) => ({
              accountId: l.accountId,
              description: l.description,
              debit: l.credit,
              credit: l.debit,
              lineOrder: i,
            })),
          reversalOfId: entry.id,
        });
      }

      entry.status = 'void';
      entry.voidReason = dto.reason;
      await manager.save(entry);
    });

    return this.getById(companyId, id);
  }

  /** Attach account number/name to each line for display. */
  private async enrich(companyId: string, entry: JournalEntry) {
    const accountIds = [...new Set(entry.lines.map((l) => l.accountId))];
    const accounts = accountIds.length
      ? await this.accountRepo.find({
          where: { id: In(accountIds), companyId },
        })
      : [];
    const map = new Map(accounts.map((a) => [a.id, a]));

    const lines = entry.lines
      .slice()
      .sort((a, b) => a.lineOrder - b.lineOrder)
      .map((l) => {
        const acc = map.get(l.accountId);
        return {
          id: l.id,
          accountId: l.accountId,
          accountNumber: acc?.accountNumber ?? '',
          accountName: acc?.name ?? '',
          description: l.description,
          debit: toDecimal(l.debit).toFixed(2),
          credit: toDecimal(l.credit).toFixed(2),
          lineOrder: l.lineOrder,
        };
      });

    return { ...entry, lines };
  }
}
