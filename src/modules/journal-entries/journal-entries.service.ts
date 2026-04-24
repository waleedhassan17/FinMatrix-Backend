import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, Brackets, DataSource, Repository } from 'typeorm';
import { JournalEntry } from './entities/journal-entry.entity';
import { JournalEntryLine } from './entities/journal-entry-line.entity';
import { PostingService } from './posting.service';
import {
  CreateJournalEntryDto,
  ListJournalEntriesQueryDto,
  UpdateJournalEntryDto,
  VoidJournalEntryDto,
} from './dto/journal-entry.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { toDecimal } from '../../common/utils/money.util';

@Injectable()
export class JournalEntriesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly posting: PostingService,
    @InjectRepository(JournalEntry)
    private readonly entryRepo: Repository<JournalEntry>,
    @InjectRepository(JournalEntryLine)
    private readonly lineRepo: Repository<JournalEntryLine>,
  ) {}

  async list(
    companyId: string,
    query: ListJournalEntriesQueryDto,
    pagination: PaginationParams,
  ) {
    const qb = this.entryRepo
      .createQueryBuilder('e')
      .where('e.companyId = :companyId', { companyId });

    if (query.status) qb.andWhere('e.status = :s', { s: query.status });
    if (query.startDate && query.endDate) {
      qb.andWhere('e.date BETWEEN :start AND :end', {
        start: query.startDate,
        end: query.endDate,
      });
    } else if (query.startDate) {
      qb.andWhere('e.date >= :start', { start: query.startDate });
    } else if (query.endDate) {
      qb.andWhere('e.date <= :end', { end: query.endDate });
    }
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
    qb.take(pagination.limit).skip(pagination.skip);

    const [data, total] = await qb.getManyAndCount();

    const counts = await this.entryRepo
      .createQueryBuilder('e')
      .select('e.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .where('e.companyId = :companyId', { companyId })
      .groupBy('e.status')
      .getRawMany<{ status: string; count: string }>();

    const summary = {
      draft: 0,
      posted: 0,
      void: 0,
      ...Object.fromEntries(counts.map((c) => [c.status, parseInt(c.count, 10)])),
    };

    return {
      data,
      summary,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    };
  }

  async getById(companyId: string, id: string): Promise<JournalEntry> {
    const entry = await this.entryRepo.findOne({
      where: { id, companyId },
      relations: { lines: true },
    });
    if (!entry) {
      throw new NotFoundException({
        code: 'NOT_FOUND',
        message: 'Journal entry not found',
      });
    }
    entry.lines.sort((a, b) => a.lineOrder - b.lineOrder);
    return entry;
  }

  create(
    companyId: string,
    userId: string,
    dto: CreateJournalEntryDto,
  ): Promise<JournalEntry> {
    return this.dataSource.transaction((manager) =>
      this.posting.createEntry(manager, {
        companyId,
        createdBy: userId,
        date: dto.date,
        memo: dto.memo ?? null,
        status: dto.status ?? 'draft',
        lines: dto.lines,
      }),
    );
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateJournalEntryDto,
  ): Promise<JournalEntry> {
    return this.dataSource.transaction(async (manager) => {
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
      if (entry.status !== 'draft') {
        throw new BadRequestException({
          code: 'CANNOT_EDIT_POSTED',
          message: 'Only draft journal entries can be edited',
        });
      }

      if (dto.date !== undefined) entry.date = dto.date;
      if (dto.memo !== undefined) entry.memo = dto.memo;

      if (dto.lines) {
        await manager.delete(JournalEntryLine, { entryId: entry.id });
        const newLines = dto.lines.map((l, i) =>
          manager.create(JournalEntryLine, {
            entryId: entry.id,
            accountId: l.accountId,
            description: l.description ?? null,
            debit: toDecimal(l.debit).toFixed(4),
            credit: toDecimal(l.credit).toFixed(4),
            lineOrder: l.lineOrder ?? i,
          }),
        );
        await manager.save(newLines);

        let td = toDecimal(0);
        let tc = toDecimal(0);
        for (const l of newLines) {
          td = td.plus(toDecimal(l.debit));
          tc = tc.plus(toDecimal(l.credit));
        }
        entry.totalDebits = td.toFixed(4);
        entry.totalCredits = tc.toFixed(4);
      }

      await manager.save(entry);
      return this.getByIdWith(manager, companyId, id);
    });
  }

  post(companyId: string, id: string, userId: string): Promise<JournalEntry> {
    return this.dataSource.transaction((manager) =>
      this.posting.postDraft(manager, companyId, id, userId),
    );
  }

  async voidEntry(
    companyId: string,
    id: string,
    userId: string,
    dto: VoidJournalEntryDto,
  ): Promise<JournalEntry> {
    return this.dataSource.transaction(async (manager) => {
      const original = await manager.findOne(JournalEntry, {
        where: { id, companyId },
        relations: { lines: true },
      });
      if (!original) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Journal entry not found',
        });
      }
      if (original.status !== 'posted') {
        throw new BadRequestException({
          code: 'CANNOT_EDIT_NON_DRAFT',
          message: 'Only posted entries can be voided',
        });
      }

      // Create reversing entry with debit <-> credit swapped.
      const reversingLines = original.lines.map((l) => ({
        accountId: l.accountId,
        description: l.description,
        debit: l.credit,
        credit: l.debit,
        lineOrder: l.lineOrder,
      }));

      const reversal = await this.posting.createEntry(manager, {
        companyId,
        createdBy: userId,
        date: new Date().toISOString().slice(0, 10),
        memo: `Reversal of ${original.reference}: ${dto.reason}`,
        status: 'posted',
        lines: reversingLines,
        reversalOfId: original.id,
      });

      original.status = 'void';
      original.voidReason = dto.reason;
      await manager.save(original);

      return this.getByIdWith(manager, companyId, reversal.id);
    });
  }

  async duplicate(
    companyId: string,
    id: string,
    userId: string,
  ): Promise<JournalEntry> {
    return this.dataSource.transaction(async (manager) => {
      const original = await manager.findOne(JournalEntry, {
        where: { id, companyId },
        relations: { lines: true },
      });
      if (!original) {
        throw new NotFoundException({
          code: 'NOT_FOUND',
          message: 'Journal entry not found',
        });
      }
      const dup = await this.posting.createEntry(manager, {
        companyId,
        createdBy: userId,
        date: new Date().toISOString().slice(0, 10),
        memo: original.memo ? `${original.memo} (copy)` : 'Copy',
        status: 'draft',
        lines: original.lines.map((l) => ({
          accountId: l.accountId,
          description: l.description,
          debit: l.debit,
          credit: l.credit,
          lineOrder: l.lineOrder,
        })),
      });
      return this.getByIdWith(manager, companyId, dup.id);
    });
  }

  private async getByIdWith(
    manager: import('typeorm').EntityManager,
    companyId: string,
    id: string,
  ): Promise<JournalEntry> {
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
    entry.lines.sort((a, b) => a.lineOrder - b.lineOrder);
    return entry;
  }
}
