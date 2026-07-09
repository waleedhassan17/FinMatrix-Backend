import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Repository } from 'typeorm';
import { Reconciliation } from './entities/reconciliation.entity';
import { GeneralLedgerEntry } from '../ledger/entities/general-ledger.entity';
import { Account } from '../accounts/entities/account.entity';
import { OperationalAuditService } from '../../common/audit/operational-audit.service';
import {
  CreateReconciliationDto,
  ListReconciliationsQueryDto,
  UnreconciledQueryDto,
} from './dto/reconciliation.dto';
import {
  addMoney,
  moneyEquals,
  subtractMoney,
  toDecimal,
} from '../../common/utils/money.util';

// Only cash/bank asset accounts can be reconciled against a statement.
const RECONCILABLE_SUB_TYPES = ['Cash', 'Bank'];

@Injectable()
export class ReconciliationsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Reconciliation)
    private readonly reconRepo: Repository<Reconciliation>,
    @InjectRepository(GeneralLedgerEntry)
    private readonly glRepo: Repository<GeneralLedgerEntry>,
    @InjectRepository(Account)
    private readonly accountRepo: Repository<Account>,
    private readonly audit: OperationalAuditService,
  ) {}

  private async getReconcilableAccount(
    companyId: string,
    accountId: string,
  ): Promise<Account> {
    const account = await this.accountRepo.findOne({
      where: { id: accountId, companyId },
    });
    if (!account) {
      throw new NotFoundException({
        code: 'ACCOUNT_NOT_FOUND',
        message: 'Account not found',
      });
    }
    if (!RECONCILABLE_SUB_TYPES.includes(account.subType)) {
      throw new BadRequestException({
        code: 'NOT_RECONCILABLE',
        message: 'Only Cash or Bank accounts can be reconciled.',
      });
    }
    return account;
  }

  /**
   * Reconciled balance carried in from prior reconciliations = net (debit −
   * credit, since bank/cash is debit-normal) of every already-reconciled row.
   */
  private async beginningBalance(
    companyId: string,
    accountId: string,
  ): Promise<string> {
    const [row] = await this.dataSource.query(
      `SELECT COALESCE(SUM(g.debit::numeric - g.credit::numeric), 0) AS v
         FROM general_ledger g
        WHERE g.company_id = $1 AND g.account_id = $2
          AND g.reconciliation_id IS NOT NULL`,
      [companyId, accountId],
    );
    return toDecimal(row?.v ?? '0').toFixed(4);
  }

  /** Bank/cash accounts eligible for reconciliation, with book + last-reconciled state. */
  async listAccounts(companyId: string) {
    const accounts = await this.accountRepo.find({
      where: { companyId, subType: In(RECONCILABLE_SUB_TYPES) },
      order: { accountNumber: 'ASC' },
    });
    return Promise.all(
      accounts.map(async (a) => {
        const last = await this.reconRepo.findOne({
          where: { companyId, accountId: a.id },
          order: { statementDate: 'DESC', createdAt: 'DESC' },
        });
        return {
          accountId: a.id,
          accountNumber: a.accountNumber,
          name: a.name,
          subType: a.subType,
          bookBalance: toDecimal(a.balance).toFixed(2),
          lastReconciledDate: last?.statementDate ?? null,
          lastReconciledBalance: last ? toDecimal(last.statementEndingBalance).toFixed(2) : null,
        };
      }),
    );
  }

  /**
   * Unreconciled GL rows for an account (up to the statement date) plus the
   * carried-in beginning balance — everything the reconcile screen needs.
   */
  async getUnreconciled(companyId: string, query: UnreconciledQueryDto) {
    const account = await this.getReconcilableAccount(companyId, query.accountId);
    const qb = this.glRepo
      .createQueryBuilder('g')
      .where('g.companyId = :companyId', { companyId })
      .andWhere('g.accountId = :accountId', { accountId: query.accountId })
      .andWhere('g.reconciliationId IS NULL');
    if (query.endDate) qb.andWhere('g.date <= :endDate', { endDate: query.endDate });
    qb.orderBy('g.date', 'ASC').addOrderBy('g.createdAt', 'ASC');
    const rows = await qb.getMany();

    const entries = rows.map((g) => ({
      id: g.id,
      date: g.date,
      reference: g.reference,
      memo: g.memo,
      sourceType: g.sourceType,
      sourceId: g.sourceId,
      debit: toDecimal(g.debit).toFixed(2),
      credit: toDecimal(g.credit).toFixed(2),
      // Signed amount for the account (debit-normal): + = deposit, − = payment.
      amount: subtractMoney(g.debit, g.credit).toFixed(2),
    }));

    // QuickBooks warns when the beginning balance no longer matches the
    // last statement's ending balance (someone touched reconciled history —
    // e.g. an out-of-band DB edit). Derived beginning == last statement
    // ending by construction, so any difference IS the broken amount.
    const beginning = toDecimal(await this.beginningBalance(companyId, account.id));
    const lastRecon = await this.reconRepo.findOne({
      where: { companyId, accountId: account.id },
      order: { statementDate: 'DESC', createdAt: 'DESC' },
    });
    const lastEnding = lastRecon ? toDecimal(lastRecon.statementEndingBalance) : null;
    const beginningMismatch =
      lastEnding !== null && !moneyEquals(beginning, lastEnding)
        ? subtractMoney(beginning.toFixed(4), lastEnding.toFixed(4)).toFixed(2)
        : null;

    return {
      accountId: account.id,
      accountName: account.name,
      accountNumber: account.accountNumber,
      beginningBalance: beginning.toFixed(2),
      lastStatementDate: lastRecon?.statementDate ?? null,
      lastStatementEndingBalance: lastEnding !== null ? lastEnding.toFixed(2) : null,
      // Non-null = WARN: beginning balance is off by this amount vs the last
      // reconciliation (reconciled history was altered outside the app).
      beginningMismatch,
      entries,
    };
  }

  async list(companyId: string, query: ListReconciliationsQueryDto) {
    const where: Record<string, unknown> = { companyId };
    if (query.accountId) where.accountId = query.accountId;
    const items = await this.reconRepo.find({
      where,
      order: { statementDate: 'DESC', createdAt: 'DESC' },
    });
    return { data: items };
  }

  async getById(companyId: string, id: string) {
    const recon = await this.reconRepo.findOne({ where: { id, companyId } });
    if (!recon) {
      throw new NotFoundException({
        code: 'RECONCILIATION_NOT_FOUND',
        message: 'Reconciliation not found',
      });
    }
    const rows = await this.glRepo.find({
      where: { companyId, reconciliationId: id },
      order: { date: 'ASC', createdAt: 'ASC' },
    });
    const shape = (g: GeneralLedgerEntry) => ({
      id: g.id,
      date: g.date,
      reference: g.reference,
      memo: g.memo,
      sourceType: g.sourceType,
      debit: toDecimal(g.debit).toFixed(2),
      credit: toDecimal(g.credit).toFixed(2),
      amount: subtractMoney(g.debit, g.credit).toFixed(2),
    });
    const entries = rows.map(shape);

    // RECONCILIATION REPORT (QuickBooks): the outstanding/uncleared items —
    // book transactions dated on/before the statement date that this
    // reconciliation did NOT clear (still unreconciled now, or cleared only
    // by a LATER reconciliation). They explain book-vs-bank timing.
    const outstandingRows: GeneralLedgerEntry[] = await this.glRepo
      .createQueryBuilder('g')
      .leftJoin(Reconciliation, 'r2', 'r2.id = g.reconciliationId')
      .where('g.companyId = :cid AND g.accountId = :aid', {
        cid: companyId,
        aid: recon.accountId,
      })
      .andWhere('g.date <= :sd', { sd: recon.statementDate })
      .andWhere('(g.reconciliationId IS NULL OR r2.createdAt > :ca)', {
        ca: recon.createdAt,
      })
      .orderBy('g.date', 'ASC')
      .addOrderBy('g.createdAt', 'ASC')
      .getMany();
    const outstanding = outstandingRows.map(shape);
    const outstandingTotal = outstandingRows
      .reduce((sum, g) => addMoney(sum, subtractMoney(g.debit, g.credit)), toDecimal('0'))
      .toFixed(2);

    return { ...recon, entries, outstanding, outstandingTotal };
  }

  /**
   * Finalise a reconciliation: verify the cleared rows tie the book cash to the
   * statement (difference must be 0), then stamp those rows reconciled. This
   * marks/verifies only — it posts no journal entries.
   */
  async create(companyId: string, userId: string, dto: CreateReconciliationDto) {
    const account = await this.getReconcilableAccount(companyId, dto.accountId);

    return this.dataSource.transaction(async (manager) => {
      const glRepo = manager.getRepository(GeneralLedgerEntry);
      const reconRepo = manager.getRepository(Reconciliation);

      // Statements reconcile in chronological order — a statement dated on or
      // before the last reconciliation would corrupt the rolled-forward
      // beginning balance of everything after it.
      const lastRecon = await reconRepo.findOne({
        where: { companyId, accountId: account.id },
        order: { statementDate: 'DESC', createdAt: 'DESC' },
      });
      if (lastRecon && dto.statementDate <= lastRecon.statementDate) {
        throw new BadRequestException({
          code: 'RECONCILIATION_OUT_OF_ORDER',
          message: `This account is already reconciled through ${lastRecon.statementDate}. The new statement date must be after that.`,
        });
      }

      const beginning = await this.beginningBalance(companyId, account.id);

      let clearedEntries: GeneralLedgerEntry[] = [];
      if (dto.clearedEntryIds.length > 0) {
        clearedEntries = await glRepo.find({
          where: {
            companyId,
            accountId: account.id,
            id: In(dto.clearedEntryIds),
            reconciliationId: IsNull(),
          },
        });
        if (clearedEntries.length !== dto.clearedEntryIds.length) {
          throw new BadRequestException({
            code: 'INVALID_CLEARED_ENTRIES',
            message:
              'Some selected entries do not belong to this account or are already reconciled.',
          });
        }
        // A statement can only clear transactions dated on/before its own
        // ending date — later book items belong to the NEXT statement.
        const late = clearedEntries.filter((g) => g.date > dto.statementDate);
        if (late.length > 0) {
          throw new BadRequestException({
            code: 'CLEARED_ENTRY_AFTER_STATEMENT',
            message: `${late.length} selected entr${late.length === 1 ? 'y is' : 'ies are'} dated after the statement ending date and cannot be cleared by this statement.`,
          });
        }
      }

      // Cleared balance = beginning + net (debit − credit) of the cleared rows.
      const clearedNet = clearedEntries.reduce(
        (sum, g) => addMoney(sum, subtractMoney(g.debit, g.credit)),
        toDecimal('0'),
      );
      const clearedBalance = addMoney(beginning, clearedNet);
      const difference = subtractMoney(dto.statementEndingBalance, clearedBalance);

      if (!moneyEquals(difference, toDecimal('0'))) {
        throw new BadRequestException({
          code: 'RECONCILIATION_OUT_OF_BALANCE',
          message: `Reconciliation is out of balance by ${difference.toFixed(2)}. The cleared balance must equal the statement ending balance.`,
        });
      }

      const recon = reconRepo.create({
        companyId,
        accountId: account.id,
        statementDate: dto.statementDate,
        statementEndingBalance: toDecimal(dto.statementEndingBalance).toFixed(4),
        beginningBalance: toDecimal(beginning).toFixed(4),
        clearedBalance: clearedBalance.toFixed(4),
        difference: difference.toFixed(4),
        clearedCount: clearedEntries.length,
        status: 'completed',
        notes: dto.notes ?? null,
        createdBy: userId,
        reconciledAt: new Date(),
      });
      const saved = await reconRepo.save(recon);

      if (clearedEntries.length > 0) {
        await glRepo.update(
          { id: In(clearedEntries.map((g) => g.id)) },
          { cleared: true, reconciliationId: saved.id },
        );
      }

      return saved;
    });
  }

  /**
   * Undo a reconciliation — unstamp its rows so they can be reconciled again.
   * Locked-down (a reconciled period must not be silently altered): only the
   * MOST RECENT reconciliation for the account may be undone (undoing an
   * older one would corrupt every later beginning balance), and the undo is
   * recorded in the operational audit trail.
   */
  async remove(companyId: string, id: string, actorUserId?: string) {
    return this.dataSource.transaction(async (manager) => {
      const reconRepo = manager.getRepository(Reconciliation);
      const glRepo = manager.getRepository(GeneralLedgerEntry);
      const recon = await reconRepo.findOne({ where: { id, companyId } });
      if (!recon) {
        throw new NotFoundException({
          code: 'RECONCILIATION_NOT_FOUND',
          message: 'Reconciliation not found',
        });
      }
      const newer = await reconRepo
        .createQueryBuilder('r')
        .where('r.companyId = :cid AND r.accountId = :aid AND r.id != :id', {
          cid: companyId,
          aid: recon.accountId,
          id,
        })
        .andWhere(
          '(r.statementDate > :sd OR (r.statementDate = :sd AND r.createdAt > :ca))',
          { sd: recon.statementDate, ca: recon.createdAt },
        )
        .getCount();
      if (newer > 0) {
        throw new BadRequestException({
          code: 'RECONCILIATION_NOT_LATEST',
          message:
            'Only the most recent reconciliation for this account can be undone. Undo the newer reconciliations first.',
        });
      }
      await glRepo.update(
        { companyId, reconciliationId: id },
        { cleared: false, reconciliationId: null },
      );
      await reconRepo.remove(recon);
      await this.audit.record({
        companyId,
        actorUserId: actorUserId ?? null,
        action: 'reconciliation_undone',
        targetType: 'reconciliation',
        targetId: id,
        details: {
          accountId: recon.accountId,
          statementDate: recon.statementDate,
          statementEndingBalance: recon.statementEndingBalance,
          clearedCount: recon.clearedCount,
        },
      });
      return { id, undone: true };
    });
  }
}
