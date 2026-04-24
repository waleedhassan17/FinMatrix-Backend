import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { EntityManager } from 'typeorm';
import Decimal from 'decimal.js';
import { Account } from '../accounts/entities/account.entity';
import { GeneralLedgerEntry } from '../ledger/entities/general-ledger.entity';
import { JournalEntry } from './entities/journal-entry.entity';
import { JournalEntryLine } from './entities/journal-entry-line.entity';
import {
  addMoney,
  moneyEquals,
  toDecimal,
} from '../../common/utils/money.util';
import { AccountType } from '../../types';
import { formatJournalRef } from '../../common/utils/reference-generator.util';

export interface PostingLineInput {
  accountId: string;
  description?: string | null;
  debit: string;
  credit: string;
  lineOrder?: number;
}

export interface CreatePostingInput {
  companyId: string;
  date: string;
  memo?: string | null;
  createdBy: string;
  lines: PostingLineInput[];
  status: 'draft' | 'posted';
  sourceType?: string;
  sourceId?: string;
  reversalOfId?: string | null;
}

/**
 * Shared posting engine. Used by the Journal Entries module AND any
 * feature service that needs to create an automatic journal entry
 * (invoices, payments, bills, credit memos, etc.).
 *
 * Responsibilities:
 *   1. Validate each line has exactly one of debit/credit > 0.
 *   2. Validate accounts exist in company + are active.
 *   3. If status == posted → assert debits == credits (money tolerance).
 *   4. Persist JournalEntry + lines.
 *   5. If posted → update account balances and write GL rows.
 */
@Injectable()
export class PostingService {
  /**
   * Reserve the next reference sequence for a company and format as JE-XXX.
   * Uses a locking SELECT to avoid race conditions when multiple entries
   * are posted concurrently.
   */
  async nextJournalReference(
    manager: EntityManager,
    companyId: string,
  ): Promise<string> {
    const res = await manager
      .createQueryBuilder(JournalEntry, 'e')
      .select('COUNT(*)', 'count')
      .where('e.companyId = :companyId', { companyId })
      .setLock('pessimistic_write')
      .getRawOne<{ count: string }>();
    const count = parseInt(res?.count ?? '0', 10);
    return formatJournalRef(count + 1);
  }

  async createEntry(
    manager: EntityManager,
    input: CreatePostingInput,
  ): Promise<JournalEntry> {
    if (input.lines.length < 2) {
      throw new BadRequestException({
        code: 'INSUFFICIENT_LINES',
        message: 'Journal entry must have at least 2 lines',
      });
    }

    // Validate line shape + fetch accounts
    const accountIds = new Set<string>();
    let totalDebits = new Decimal(0);
    let totalCredits = new Decimal(0);

    for (const line of input.lines) {
      const d = toDecimal(line.debit);
      const c = toDecimal(line.credit);
      const debitPositive = d.greaterThan(0);
      const creditPositive = c.greaterThan(0);
      if (debitPositive === creditPositive) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message:
            'Each line must have exactly one of debit > 0 or credit > 0 (never both, never neither)',
        });
      }
      if (d.lessThan(0) || c.lessThan(0)) {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'Debit and credit values must be non-negative',
        });
      }
      totalDebits = totalDebits.plus(d);
      totalCredits = totalCredits.plus(c);
      accountIds.add(line.accountId);
    }

    const accounts = await manager.find(Account, {
      where: Array.from(accountIds).map((id) => ({ id, companyId: input.companyId })),
    });
    if (accounts.length !== accountIds.size) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'One or more accounts not found in this company',
      });
    }
    for (const a of accounts) {
      if (!a.isActive) {
        throw new BadRequestException({
          code: 'ACCOUNT_INACTIVE',
          message: `Account ${a.accountNumber} is inactive`,
        });
      }
    }
    const accountMap = new Map(accounts.map((a) => [a.id, a]));

    if (input.status === 'posted' && !moneyEquals(totalDebits, totalCredits)) {
      throw new BadRequestException({
        code: 'UNBALANCED_ENTRY',
        message: `Debits (${totalDebits.toFixed(4)}) must equal credits (${totalCredits.toFixed(4)})`,
      });
    }

    const reference = await this.nextJournalReference(manager, input.companyId);

    const entry = manager.create(JournalEntry, {
      companyId: input.companyId,
      reference,
      date: input.date,
      memo: input.memo ?? null,
      status: input.status,
      totalDebits: totalDebits.toFixed(4),
      totalCredits: totalCredits.toFixed(4),
      createdBy: input.createdBy,
      postedBy: input.status === 'posted' ? input.createdBy : null,
      postedAt: input.status === 'posted' ? new Date() : null,
      voidReason: null,
      reversalOfId: input.reversalOfId ?? null,
    });
    await manager.save(entry);

    const lineEntities = input.lines.map((l, i) =>
      manager.create(JournalEntryLine, {
        entryId: entry.id,
        accountId: l.accountId,
        description: l.description ?? null,
        debit: toDecimal(l.debit).toFixed(4),
        credit: toDecimal(l.credit).toFixed(4),
        lineOrder: l.lineOrder ?? i,
      }),
    );
    await manager.save(lineEntities);
    entry.lines = lineEntities;

    if (input.status === 'posted') {
      await this.applyPosting(manager, entry, accountMap, {
        sourceType: input.sourceType ?? 'journal_entry',
        sourceId: input.sourceId ?? entry.id,
      });
    }

    return entry;
  }

  async postDraft(
    manager: EntityManager,
    companyId: string,
    entryId: string,
    postedBy: string,
  ): Promise<JournalEntry> {
    const entry = await manager.findOne(JournalEntry, {
      where: { id: entryId, companyId },
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
        code: 'CANNOT_EDIT_NON_DRAFT',
        message: 'Only draft entries can be posted',
      });
    }
    let totalDebits = new Decimal(0);
    let totalCredits = new Decimal(0);
    for (const l of entry.lines) {
      totalDebits = totalDebits.plus(toDecimal(l.debit));
      totalCredits = totalCredits.plus(toDecimal(l.credit));
    }
    if (!moneyEquals(totalDebits, totalCredits)) {
      throw new BadRequestException({
        code: 'UNBALANCED_ENTRY',
        message: `Debits (${totalDebits.toFixed(4)}) must equal credits (${totalCredits.toFixed(4)})`,
      });
    }

    const accountIds = Array.from(new Set(entry.lines.map((l) => l.accountId)));
    const accounts = await manager.find(Account, {
      where: accountIds.map((id) => ({ id, companyId })),
    });
    const accountMap = new Map(accounts.map((a) => [a.id, a]));

    entry.status = 'posted';
    entry.postedBy = postedBy;
    entry.postedAt = new Date();
    entry.totalDebits = totalDebits.toFixed(4);
    entry.totalCredits = totalCredits.toFixed(4);
    await manager.save(entry);

    await this.applyPosting(manager, entry, accountMap, {
      sourceType: 'journal_entry',
      sourceId: entry.id,
    });
    return entry;
  }

  /**
   * Applies balance deltas + writes GL rows for a posted entry.
   */
  private async applyPosting(
    manager: EntityManager,
    entry: JournalEntry,
    accountMap: Map<string, Account>,
    source: { sourceType: string; sourceId: string },
  ): Promise<void> {
    // Aggregate deltas per account
    const deltas = new Map<string, Decimal>();
    for (const l of entry.lines) {
      const acc = accountMap.get(l.accountId)!;
      const delta = this.signedDelta(acc.type, toDecimal(l.debit), toDecimal(l.credit));
      deltas.set(l.accountId, (deltas.get(l.accountId) ?? new Decimal(0)).plus(delta));
    }

    // Apply to account balances
    for (const [accountId, delta] of deltas) {
      const acc = accountMap.get(accountId)!;
      const newBalance = toDecimal(acc.balance).plus(delta);
      acc.balance = newBalance.toFixed(4);
      await manager.save(acc);
    }

    // Write GL rows with running balance per account
    const accountsTouched = new Map<string, Decimal>();
    const glRows: GeneralLedgerEntry[] = [];
    for (const l of entry.lines) {
      const acc = accountMap.get(l.accountId)!;
      const d = toDecimal(l.debit);
      const c = toDecimal(l.credit);
      const delta = this.signedDelta(acc.type, d, c);
      const prior =
        accountsTouched.get(acc.id) ??
        toDecimal(acc.balance).minus(deltas.get(acc.id) ?? new Decimal(0));
      const running = prior.plus(delta);
      accountsTouched.set(acc.id, running);

      glRows.push(
        manager.create(GeneralLedgerEntry, {
          companyId: entry.companyId,
          date: entry.date,
          reference: entry.reference,
          accountId: acc.id,
          debit: d.toFixed(4),
          credit: c.toFixed(4),
          balance: running.toFixed(4),
          sourceType: source.sourceType,
          sourceId: source.sourceId,
          memo: entry.memo,
        }),
      );
    }
    await manager.save(glRows);
  }

  /**
   * Accounting sign convention:
   *   asset, expense       → balance increases with debit
   *   liability, equity,
   *   revenue              → balance increases with credit
   */
  private signedDelta(
    type: AccountType,
    debit: Decimal,
    credit: Decimal,
  ): Decimal {
    if (type === 'asset' || type === 'expense') {
      return debit.minus(credit);
    }
    return credit.minus(debit);
  }
}
