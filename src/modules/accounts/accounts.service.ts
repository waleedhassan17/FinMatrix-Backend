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
  ACCT_GOODS_IN_TRANSIT,
  ACCT_GRNI,
  ACCT_INVENTORY,
  ACCT_INPUT_TAX,
  ACCT_INVENTORY_ADJUSTMENT,
  ACCT_INVENTORY_COUNT_VARIANCE,
  ACCT_OPENING_BALANCE_EQUITY,
  ACCT_SALARY_EXPENSE,
  ACCT_SALES_REVENUE,
  ACCT_SHRINKAGE_DAMAGE,
  ACCT_SHRINKAGE_OBSOLESCENCE,
  ACCT_SHRINKAGE_THEFT,
  ACCT_TAX_PAYABLE,
  isValidSubType,
  SYSTEM_ACCOUNT_DEFS,
  ACCT_CUSTOMER_ADVANCES,
  ACCT_PAYROLL_LIABILITIES,
} from './accounts.constants';
import { AccountType } from '../../types';

// Canonical accounts that auto-posting (invoices, payments, bills, tax,
// payroll, inventory) depends on — these may never be deleted OR deactivated.
//
// Deactivation used to be unguarded, and it is the more dangerous of the two:
// delete() at least refuses, while toggle() would happily switch off Cash and
// leave every cash payment, PAID delivery approval, credit-memo refund, tax
// payment and payroll run failing with "Account 1000 is not active" — an error
// naming an account the user was never thinking about.
const SYSTEM_ACCOUNT_NUMBERS: ReadonlySet<string> = new Set([
  ACCT_CASH,
  ACCT_BANK,
  ACCT_AR,
  ACCT_INVENTORY,
  ACCT_GOODS_IN_TRANSIT,
  ACCT_GRNI,
  ACCT_AP,
  ACCT_TAX_PAYABLE,
  ACCT_OPENING_BALANCE_EQUITY,
  ACCT_SALES_REVENUE,
  ACCT_COGS,
  ACCT_INVENTORY_ADJUSTMENT,
  ACCT_INPUT_TAX,
  ACCT_SALARY_EXPENSE,
  ACCT_CUSTOMER_ADVANCES,
  // Payroll withholding posts here; switching it off would fail every payroll
  // run that has a deduction.
  ACCT_PAYROLL_LIABILITIES,
  // Every inventory adjustment offsets against one of these, chosen by the
  // reason the user picked — switching one off would fail the adjustment with
  // an error naming an account they never chose directly.
  ACCT_SHRINKAGE_DAMAGE,
  ACCT_SHRINKAGE_THEFT,
  ACCT_SHRINKAGE_OBSOLESCENCE,
  ACCT_INVENTORY_COUNT_VARIANCE,
]);

/** Shared by delete() and the deactivation guard. */
export const isSystemAccountNumber = (accountNumber: string): boolean =>
  SYSTEM_ACCOUNT_NUMBERS.has(accountNumber);
import { PaginationParams } from '../../common/pipes/parse-pagination.pipe';
import { toDecimal } from '../../common/utils/money.util';
import { assertMoneyAccount } from '../../common/utils/money-account.util';
import {
  ACCOUNT_USAGE_SQL,
  AccountUsage,
  describeUsage,
  EMPTY_USAGE,
  structureOf,
  usageTotal,
} from './account-structure.util';
import { PostingService } from '../journal-entries/posting.service';
import { businessToday } from '../../common/utils/business-date.util';
import { pagedResponse } from '../../common/utils/paged-response.util';

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
    // Tell the client which accounts auto-posting depends on, so it can hide
    // the Deactivate action instead of showing "System Account: No" on Cash
    // and letting the tap fail server-side.
    return { accounts: accounts.map((a) => this.withSystemFlag(a)), summary };
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

  private withSystemFlag<T extends { accountNumber: string }>(account: T) {
    return { ...account, isSystemAccount: SYSTEM_ACCOUNT_NUMBERS.has(account.accountNumber) };
  }

  async getDetail(companyId: string, id: string) {
    const account = await this.getById(companyId, id);
    const recentEntries = await this.glRepo.find({
      where: { companyId, accountId: id },
      order: { date: 'DESC', createdAt: 'DESC' },
      take: 10,
    });
    const usage = await this.usage(this.dataSource.manager, companyId, id);
    return {
      account: this.withSystemFlag(account),
      recentEntries,
      // Whether the edit form may unlock Type and Number, and why not.
      usage,
      structure: structureOf(SYSTEM_ACCOUNT_NUMBERS.has(account.accountNumber), usage),
    };
  }

  /** What refers to this account — see account-structure.util.ts. */
  async usage(
    manager: EntityManager,
    companyId: string,
    id: string,
  ): Promise<AccountUsage> {
    const [row] = await manager.query(ACCOUNT_USAGE_SQL, [companyId, id]);
    return { ...EMPTY_USAGE, ...(row ?? {}) };
  }

  /**
   * The cash or bank account money moves through: the one chosen, checked to
   * be this company's, an asset of kind Cash or Bank, and active — or, when
   * none was chosen, the account it has always defaulted to.
   *
   * One place for the rule, so a receipt, a refund, a tax payment and a
   * payroll run cannot drift into accepting different things.
   */
  async resolveMoneyAccount(
    manager: EntityManager,
    companyId: string,
    accountId: string | null | undefined,
    fallbackNumber: string,
  ): Promise<Account> {
    if (!accountId) {
      return this.getByNumberOrFail(companyId, fallbackNumber, manager);
    }
    const found = await manager.findOne(Account, {
      where: { id: accountId, companyId },
    });
    if (!found) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Bank/Cash account not found',
      });
    }
    assertMoneyAccount(found);
    return found;
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
          date: businessToday(),
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

  /**
   * Edit an account.
   *
   * Name, kind, parent, description and active can change as before. Type and
   * number can change too, but only while nothing refers to the account (see
   * account-structure.util.ts) — which is what lets "Meezan Bank", saved by
   * mistake as an Other Expense, become the bank account it was meant to be.
   *
   * The account row is locked first. Posting moves an account's balance, so a
   * posting racing this edit waits for it, and one that committed first is
   * counted below.
   */
  async update(
    companyId: string,
    id: string,
    dto: UpdateAccountDto,
  ): Promise<Account> {
    return this.dataSource.transaction(async (manager) => {
      const account = await manager
        .getRepository(Account)
        .createQueryBuilder('a')
        .setLock('pessimistic_write')
        .where('a.id = :id AND a.companyId = :companyId', { id, companyId })
        .getOne();
      if (!account) {
        throw new NotFoundException({
          code: 'ACCOUNT_NOT_FOUND',
          message: 'Account not found',
        });
      }

      const label = `${account.accountNumber} · ${account.name}`;
      const nextNumber =
        dto.accountNumber !== undefined ? dto.accountNumber.trim() : account.accountNumber;
      const nextType = dto.type ?? account.type;
      const nextSubType = dto.subType ?? account.subType;
      const typeChanges = nextType !== account.type;
      const numberChanges = nextNumber !== account.accountNumber;

      if (isSystemAccountNumber(account.accountNumber)) {
        // Renaming is fine; what automatic posting relies on is not.
        if (typeChanges || numberChanges || nextSubType !== account.subType) {
          throw new BadRequestException({
            code: 'SYSTEM_ACCOUNT_FIXED',
            message:
              `${label} is a system account — invoices, payments and bills post to it ` +
              'automatically by its number and kind, so those are fixed. You can rename it.',
          });
        }
      }

      if (typeChanges || numberChanges) {
        const usage = await this.usage(manager, companyId, id);
        if (usageTotal(usage) > 0) {
          throw new BadRequestException({
            code: 'ACCOUNT_IN_USE',
            message:
              `${label} is already in use (${describeUsage(usage)}), so its type and number ` +
              'are fixed. Create the account you need, move anything on this one across ' +
              'with a journal entry, then deactivate it.',
          });
        }
        if (typeChanges && usage.children > 0) {
          throw new BadRequestException({
            code: 'ACCOUNT_HAS_CHILDREN',
            message: `${label} has sub-accounts. Move them first to change its type.`,
          });
        }
        if (numberChanges) {
          if (nextNumber.length < 2) {
            throw new BadRequestException({
              code: 'VALIDATION_FAILED',
              message: 'An account number needs at least 2 characters.',
            });
          }
          const taken = await manager.findOne(Account, {
            where: { companyId, accountNumber: nextNumber },
          });
          if (taken) {
            throw new ConflictException({
              code: 'DUPLICATE_ACCOUNT_NUMBER',
              message: `${nextNumber} is already ${taken.name}. Choose another number.`,
            });
          }
        }
      }

      if (!isValidSubType(nextType, nextSubType)) {
        throw new BadRequestException({
          code: 'INVALID_SUB_TYPE',
          message: `subType '${nextSubType}' is not valid for type '${nextType}'`,
        });
      }

      // The parent must be of the same type, or the account is drawn in one
      // section of the chart and rolls up into another. A parent the account
      // had before a type change is let go; one chosen now must match.
      let nextParentId =
        dto.parentId !== undefined ? dto.parentId || null : account.parentId;
      if (nextParentId) {
        if (nextParentId === account.id) {
          throw new BadRequestException({
            code: 'VALIDATION_FAILED',
            message: 'An account cannot be its own parent.',
          });
        }
        const parent = await manager.findOne(Account, {
          where: { id: nextParentId, companyId },
        });
        if (!parent) {
          throw new NotFoundException({
            code: 'ACCOUNT_NOT_FOUND',
            message: 'Parent account not found',
          });
        }
        if (parent.type !== nextType) {
          const chosenNow =
            dto.parentId !== undefined && dto.parentId !== account.parentId;
          if (chosenNow) {
            throw new BadRequestException({
              code: 'PARENT_TYPE_MISMATCH',
              message: `${parent.accountNumber} · ${parent.name} is a ${parent.type} account, so it cannot hold a ${nextType} account.`,
            });
          }
          nextParentId = null;
        }
      }

      account.accountNumber = nextNumber;
      account.type = nextType;
      account.subType = nextSubType;
      account.parentId = nextParentId;
      if (dto.name !== undefined) account.name = dto.name;
      if (dto.description !== undefined) account.description = dto.description;
      if (dto.isActive !== undefined) {
        if (account.isActive && !dto.isActive) this.assertCanDeactivate(account);
        account.isActive = dto.isActive;
      }
      const saved = await manager.save(account);
      return this.withSystemFlag(saved) as Account;
    });
  }

  /**
   * Deactivating an account hides it from new postings but leaves its balance
   * on the Balance Sheet — so an account switched off with money in it can no
   * longer be corrected, and any auto-posting that needs it fails on an
   * unrelated screen days later. Re-ACTIVATING is always allowed.
   */
  private assertCanDeactivate(account: Account): void {
    if (SYSTEM_ACCOUNT_NUMBERS.has(account.accountNumber)) {
      throw new BadRequestException({
        code: 'SYSTEM_ACCOUNT_REQUIRED',
        message:
          `${account.accountNumber} ${account.name} is a system account — invoices, payments, ` +
          'bills, tax and payroll post to it automatically, so it cannot be deactivated.',
      });
    }
    if (!toDecimal(account.balance).isZero()) {
      throw new BadRequestException({
        code: 'ACCOUNT_HAS_BALANCE',
        message:
          `${account.accountNumber} ${account.name} still holds ${account.balance}. ` +
          'Move the balance to another account first — deactivating it would leave that ' +
          'money on the Balance Sheet with no way to correct it.',
      });
    }
  }

  async toggle(companyId: string, id: string): Promise<Account> {
    const account = await this.getById(companyId, id);
    if (account.isActive) this.assertCanDeactivate(account);
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
      // id breaks ties: one posting writes its lines with one timestamp, and
      // page 2 must continue page 1 exactly.
      order: { date: 'DESC', createdAt: 'DESC', id: 'DESC' },
      take: pagination.limit,
      skip: pagination.skip,
    });
    // pagedResponse, not `{ data, pagination }`: the response envelope keeps
    // only `data` from the latter, so every client saw one page of the
    // ledger and could not tell there was more.
    return pagedResponse(data, {
      page: pagination.page,
      limit: pagination.limit,
      total,
    });
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
