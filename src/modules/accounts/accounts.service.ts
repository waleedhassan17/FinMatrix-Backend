import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, DataSource, EntityManager, ILike, Repository } from 'typeorm';
import { Account } from './entities/account.entity';
import { GeneralLedgerEntry } from '../ledger/entities/general-ledger.entity';
import {
  CreateAccountDto,
  ListAccountsQueryDto,
  UpdateAccountDto,
} from './dto/account.dto';
import {
  ACCT_AP,
  ACCT_AR,
  ACCT_BANK,
  ACCT_CASH,
  ACCT_COGS,
  ACCT_GRNI,
  ACCT_INVENTORY,
  ACCT_INVENTORY_ADJUSTMENT,
  ACCT_OPENING_BALANCE_EQUITY,
  ACCT_SALES_REVENUE,
  ACCT_TAX_PAYABLE,
  isValidSubType,
  SYSTEM_ACCOUNT_DEFS,
} from './accounts.constants';
import { AccountType } from '../../types';

// Canonical accounts that auto-posting (invoices, payments, bills, tax,
// payroll, inventory) depends on — these may never be deleted.
const SYSTEM_ACCOUNT_NUMBERS: ReadonlySet<string> = new Set([
  ACCT_CASH,
  ACCT_BANK,
  ACCT_AR,
  ACCT_INVENTORY,
  ACCT_GRNI,
  ACCT_AP,
  ACCT_TAX_PAYABLE,
  ACCT_OPENING_BALANCE_EQUITY,
  ACCT_SALES_REVENUE,
  ACCT_COGS,
  ACCT_INVENTORY_ADJUSTMENT,
]);
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { toDecimal } from '../../common/utils/money.util';
import { PostingService } from '../journal-entries/posting.service';

@Injectable()
export class AccountsService {
  constructor(
    @InjectRepository(Account)
    private readonly repo: Repository<Account>,
    @InjectRepository(GeneralLedgerEntry)
    private readonly glRepo: Repository<GeneralLedgerEntry>,
    private readonly dataSource: DataSource,
    private readonly posting: PostingService,
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

  async create(
    companyId: string,
    dto: CreateAccountDto,
    userId: string,
  ): Promise<Account> {
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

    const opening = toDecimal(dto.openingBalance ?? '0');

    // Account creation AND its opening-balance journal entry must be atomic:
    // either both land or neither does, so the Trial Balance never drifts.
    return this.dataSource.transaction(async (manager) => {
      const account = manager.create(Account, {
        companyId,
        accountNumber: dto.accountNumber,
        name: dto.name,
        type: dto.type,
        subType: dto.subType,
        parentId: dto.parentId ?? null,
        description: dto.description ?? null,
        openingBalance: opening.toFixed(4),
        // balance starts at 0; the opening journal posting (below) moves it
        // to the opening amount via the normal balance-update path so the
        // GL, account balance, and offsetting equity all stay consistent.
        balance: '0',
        isActive: true,
      });
      await manager.save(account);

      // Per §3.12: a non-zero opening balance MUST post an offsetting entry
      // to Opening Balance Equity (3900) in the same transaction. Without
      // this the books are unbalanced. The OBE account itself is exempt
      // (it would offset to itself) and is seeded with no opening balance.
      if (
        !opening.isZero() &&
        dto.accountNumber !== ACCT_OPENING_BALANCE_EQUITY
      ) {
        const obe = await this.getOrCreateSystemAccount(
          manager,
          companyId,
          ACCT_OPENING_BALANCE_EQUITY,
        );

        // Debit-normal accounts (asset/expense) increase with a debit; a
        // positive opening balance debits the account and credits OBE.
        // Credit-normal accounts (liability/equity/revenue) do the reverse.
        const debitNormal =
          account.type === 'asset' || account.type === 'expense';
        const magnitude = opening.abs().toFixed(4);
        const accountDebits = debitNormal === opening.greaterThan(0);

        const accountLine = accountDebits
          ? { accountId: account.id, debit: magnitude, credit: '0' }
          : { accountId: account.id, debit: '0', credit: magnitude };
        const obeLine = accountDebits
          ? { accountId: obe.id, debit: '0', credit: magnitude }
          : { accountId: obe.id, debit: magnitude, credit: '0' };

        await this.posting.createEntry(manager, {
          companyId,
          createdBy: userId,
          date: new Date().toISOString().slice(0, 10),
          memo: `Opening balance for ${account.accountNumber} ${account.name}`,
          status: 'posted',
          lines: [accountLine, obeLine].map((l, i) => ({ ...l, lineOrder: i })),
          sourceType: 'opening_balance',
          sourceId: account.id,
        });
      }

      return manager.findOneOrFail(Account, {
        where: { id: account.id, companyId },
      });
    });
  }

  /**
   * Resolve a system account by number, creating it (active) if a company's
   * chart predates it. Used for Opening Balance Equity / GRNI which auto-
   * posting depends on but older companies may not have.
   */
  async getOrCreateSystemAccount(
    manager: EntityManager,
    companyId: string,
    accountNumber: string,
  ): Promise<Account> {
    const repo = manager.getRepository(Account);
    const existing = await repo.findOne({
      where: { companyId, accountNumber },
    });
    if (existing) {
      if (!existing.isActive) {
        existing.isActive = true;
        await repo.save(existing);
      }
      return existing;
    }
    const def = SYSTEM_ACCOUNT_DEFS[accountNumber];
    if (!def) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: `System account ${accountNumber} is not defined`,
      });
    }
    const created = repo.create({
      companyId,
      accountNumber,
      name: def.name,
      type: def.type,
      subType: def.subType,
      parentId: null,
      description: null,
      openingBalance: '0',
      balance: '0',
      isActive: true,
    });
    return repo.save(created);
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

  async delete(companyId: string, id: string) {
    const account = await this.getById(companyId, id);

    // 1. System accounts underpin every auto-posting path — never deletable.
    if (SYSTEM_ACCOUNT_NUMBERS.has(account.accountNumber)) {
      throw new BadRequestException({
        code: 'SYSTEM_ACCOUNT_PROTECTED',
        message: `Account ${account.accountNumber} (${account.name}) is a system account required by automatic posting and cannot be deleted. Deactivate it instead if it is unused.`,
      });
    }

    // 2. An account with posted ledger history must never be hard-deleted —
    //    that would orphan journal/GL references and break the financial
    //    statements. QuickBooks-style: deactivate (make inactive) instead.
    const glCount = await this.glRepo.count({ where: { companyId, accountId: id } });
    if (glCount > 0) {
      throw new BadRequestException({
        code: 'ACCOUNT_HAS_TRANSACTIONS',
        message:
          'This account has posted transactions and cannot be deleted. Deactivate it instead to hide it from new entries while preserving history.',
      });
    }

    // 3. Block deletion while sub-accounts still point at it.
    const childCount = await this.repo.count({ where: { companyId, parentId: id } });
    if (childCount > 0) {
      throw new BadRequestException({
        code: 'ACCOUNT_HAS_CHILDREN',
        message: 'This account has sub-accounts. Reassign or remove them first.',
      });
    }

    // Safe to hard-delete: no postings, no children, not a system account.
    await this.repo.remove(account);
    return { id, deleted: true };
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
