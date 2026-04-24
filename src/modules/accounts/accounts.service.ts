import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, EntityManager, ILike, Repository } from 'typeorm';
import { Account } from './entities/account.entity';
import { GeneralLedgerEntry } from '../ledger/entities/general-ledger.entity';
import {
  CreateAccountDto,
  ListAccountsQueryDto,
  UpdateAccountDto,
} from './dto/account.dto';
import { isValidSubType } from './accounts.constants';
import { AccountType } from '../../types';
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { toDecimal } from '../../common/utils/money.util';

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(Account)
    private readonly repo: Repository<Account>,
    @InjectRepository(GeneralLedgerEntry)
    private readonly glRepo: Repository<GeneralLedgerEntry>,
  ) {}

  async list(companyId: string, query: ListAccountsQueryDto) {
    const qb = this.repo
      .createQueryBuilder('a')
      .where('a.companyId = :companyId', { companyId });

    if (query.type) qb.andWhere('a.type = :type', { type: query.type });
    if (query.subType) qb.andWhere('a.subType = :subType', { subType: query.subType });
    if (query.isActive !== undefined) {
      qb.andWhere('a.isActive = :active', { active: query.isActive });
    }
    if (query.search) {
      qb.andWhere(
        new Brackets((w) => {
          w.where('a.name ILIKE :s', { s: `%${query.search}%` }).orWhere(
            'a.accountNumber ILIKE :s',
            { s: `%${query.search}%` },
          );
        }),
      );
    }

    qb.orderBy('a.accountNumber', 'ASC');
    const accounts = await qb.getMany();

    const summary = this.summarize(accounts);
    return { accounts, summary };
  }

  async getById(companyId: string, id: string): Promise<Account> {
    const account = await this.repo.findOne({ where: { id, companyId } });
    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }
    return account;
  }

  async getDetail(companyId: string, id: string) {
    const account = await this.getById(companyId, id);
    const recentEntries = await this.glRepo.find({
      where: { companyId, accountId: id },
      order: { date: 'DESC', createdAt: 'DESC' },
      take: 10,
    });
    return { account, recentEntries };
  }

  async create(companyId: string, dto: CreateAccountDto): Promise<Account> {
    if (!isValidSubType(dto.type, dto.subType)) {
      throw new BadRequestException({
        code: 'INVALID_SUB_TYPE',
        message: `subType '${dto.subType}' is not valid for type '${dto.type}'`,
      });
    }
    const duplicate = await this.repo.findOne({
      where: { companyId, accountNumber: dto.accountNumber },
    });
    if (duplicate) {
      throw new ConflictException({
        code: 'DUPLICATE_ACCOUNT_NUMBER',
        message: 'Account number already exists for this company',
      });
    }
    if (dto.parentId) {
      await this.getById(companyId, dto.parentId);
    }
    const opening = dto.openingBalance ?? '0';
    const account = this.repo.create({
      companyId,
      accountNumber: dto.accountNumber,
      name: dto.name,
      type: dto.type,
      subType: dto.subType,
      parentId: dto.parentId ?? null,
      description: dto.description ?? null,
      openingBalance: opening,
      balance: opening,
      isActive: true,
    });
    return this.repo.save(account);
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateAccountDto,
  ): Promise<Account> {
    const account = await this.getById(companyId, id);
    // accountNumber and type are IMMUTABLE per spec
    if (dto.name !== undefined) account.name = dto.name;
    if (dto.subType !== undefined) {
      if (!isValidSubType(account.type, dto.subType)) {
        throw new BadRequestException({
          code: 'INVALID_SUB_TYPE',
          message: `subType '${dto.subType}' is not valid for type '${account.type}'`,
        });
      }
      account.subType = dto.subType;
    }
    if (dto.description !== undefined) account.description = dto.description;
    if (dto.parentId !== undefined) {
      if (dto.parentId) await this.getById(companyId, dto.parentId);
      account.parentId = dto.parentId ?? null;
    }
    if (dto.isActive !== undefined) account.isActive = dto.isActive;
    return this.repo.save(account);
  }

  async toggle(companyId: string, id: string): Promise<Account> {
    const account = await this.getById(companyId, id);
    account.isActive = !account.isActive;
    return this.repo.save(account);
  }

  async transactions(
    companyId: string,
    accountId: string,
    pagination: PaginationParams,
  ) {
    await this.getById(companyId, accountId);
    const [data, total] = await this.glRepo.findAndCount({
      where: { companyId, accountId },
      order: { date: 'DESC', createdAt: 'DESC' },
      take: pagination.limit,
      skip: pagination.skip,
    });
    return {
      data,
      pagination: {
        page: pagination.page,
        limit: pagination.limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / pagination.limit)),
      },
    };
  }

  /**
   * Load active account by (companyId, accountNumber) — used by auto journal entries.
   */
  async getByNumberOrFail(
    companyId: string,
    accountNumber: string,
    manager?: EntityManager,
  ): Promise<Account> {
    const repo = manager ? manager.getRepository(Account) : this.repo;
    const acc = await repo.findOne({ where: { companyId, accountNumber } });
    if (!acc) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: `Account ${accountNumber} not found in chart of accounts`,
      });
    }
    if (!acc.isActive) {
      throw new BadRequestException({
        code: 'ACCOUNT_INACTIVE',
        message: `Account ${accountNumber} is not active`,
      });
    }
    return acc;
  }

  private summarize(accounts: Account[]) {
    const totals: Record<AccountType, string> = {
      asset: '0',
      liability: '0',
      equity: '0',
      revenue: '0',
      expense: '0',
    };
    const counts: Record<AccountType, number> = {
      asset: 0,
      liability: 0,
      equity: 0,
      revenue: 0,
      expense: 0,
    };
    for (const a of accounts) {
      totals[a.type] = toDecimal(totals[a.type]).plus(toDecimal(a.balance)).toFixed(4);
      counts[a.type] += 1;
    }
    return { totals, counts, totalAccounts: accounts.length };
  }
}
