import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { GeneralLedgerEntry } from './entities/general-ledger.entity';
import { LedgerQueryDto } from './dto/ledger-query.dto';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { addMoney, moneyEquals, toDecimal } from '../../common/utils/money.util';

@Injectable()
export class LedgerService {
  constructor(
    @InjectRepository(GeneralLedgerEntry)
    private readonly repo: Repository<GeneralLedgerEntry>,
  ) {}

  async list(
    companyId: string,
    query: LedgerQueryDto,
    pagination: PaginationParams,
  ) {
    const qb = this.repo
      .createQueryBuilder('g')
      .where('g.companyId = :companyId', { companyId })
      .andWhere('g.date BETWEEN :start AND :end', {
        start: query.startDate,
        end: query.endDate,
      });
    if (query.accountId) {
      qb.andWhere('g.accountId = :aid', { aid: query.accountId });
    }
    qb.orderBy('g.date', 'ASC').addOrderBy('g.createdAt', 'ASC');

    const [data, total] = await qb
      .clone()
      .take(pagination.limit)
      .skip(pagination.skip)
      .getManyAndCount();

    // Compute totals across the full filter (not just current page).
    const totalsRaw = await qb
      .clone()
      .select('SUM(g.debit)', 'debit')
      .addSelect('SUM(g.credit)', 'credit')
      .getRawOne<{ debit: string | null; credit: string | null }>();

    const totalDebits = toDecimal(totalsRaw?.debit ?? 0).toFixed(4);
    const totalCredits = toDecimal(totalsRaw?.credit ?? 0).toFixed(4);

    return {
      data,
      totals: {
        totalDebits,
        totalCredits,
        isBalanced: moneyEquals(totalDebits, totalCredits),
      },
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    };
  }
}
