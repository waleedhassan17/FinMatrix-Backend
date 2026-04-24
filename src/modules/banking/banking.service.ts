import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BankAccount } from './entities/bank-account.entity';
import { BankTransaction } from './entities/bank-transaction.entity';
import { Reconciliation } from './entities/reconciliation.entity';
import { CreateBankAccountDto, UpdateBankAccountDto, CreateBankTransactionDto, ReconcileDto, BankAccountQueryDto } from './dto/banking.dto';
import { toDecimal } from '../../common/utils/money.util';

@Injectable()
export class BankingService {
  constructor(
    @InjectRepository(BankAccount) private readonly accountRepo: Repository<BankAccount>,
    @InjectRepository(BankTransaction) private readonly txRepo: Repository<BankTransaction>,
    @InjectRepository(Reconciliation) private readonly recRepo: Repository<Reconciliation>,
    private readonly dataSource: DataSource,
  ) {}

  async listAccounts(companyId: string, query: BankAccountQueryDto, page: number, limit: number) {
    const qb = this.accountRepo.createQueryBuilder('a').where('a.companyId = :cid', { cid: companyId });
    if (query.isActive !== undefined) qb.andWhere('a.isActive = :a', { a: query.isActive });
    qb.orderBy('a.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async getAccount(companyId: string, id: string) {
    const a = await this.accountRepo.findOne({ where: { id, companyId } });
    if (!a) throw new NotFoundException('Bank account not found');
    return a;
  }

  async createAccount(companyId: string, dto: CreateBankAccountDto) {
    const acc = this.accountRepo.create({ ...dto, companyId, balance: '0' } as any);
    return this.accountRepo.save(acc);
  }

  async updateAccount(companyId: string, id: string, dto: UpdateBankAccountDto) {
    const a = await this.getAccount(companyId, id);
    Object.assign(a, dto);
    return this.accountRepo.save(a);
  }

  async deleteAccount(companyId: string, id: string) {
    const a = await this.getAccount(companyId, id);
    await this.accountRepo.softRemove(a);
    return { id, deleted: true };
  }

  async listTransactions(companyId: string, bankAccountId: string, page: number, limit: number) {
    const qb = this.txRepo.createQueryBuilder('t')
      .where('t.companyId = :cid AND t.bankAccountId = :bid', { cid: companyId, bid: bankAccountId })
      .orderBy('t.date', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async createTransaction(companyId: string, dto: CreateBankTransactionDto, userId: string) {
    return this.dataSource.transaction(async (em) => {
      const accRepo = em.getRepository(BankAccount);
      const txRepo = em.getRepository(BankTransaction);
      const account = await accRepo.findOne({ where: { id: dto.bankAccountId, companyId } });
      if (!account) throw new NotFoundException('Bank account not found');

      const balance = toDecimal(account.balance);
      const amount = toDecimal(dto.amount);
      const newBalance = dto.type === 'expense' || dto.type === 'fee' || dto.type === 'check'
        ? balance.minus(amount)
        : balance.plus(amount);

      account.balance = newBalance.toFixed(4);
      await accRepo.save(account);

      const tx = txRepo.create({
        companyId,
        bankAccountId: dto.bankAccountId,
        date: dto.date,
        type: dto.type as any,
        payee: dto.payee ?? null,
        reference: dto.reference ?? null,
        amount: dto.amount,
        balance: newBalance.toFixed(4),
        accountId: dto.accountId ?? null,
        memo: dto.memo ?? null,
        isCleared: false,
      } as any);
      return txRepo.save(tx);
    });
  }

  async reconcile(companyId: string, bankAccountId: string, dto: ReconcileDto, userId: string) {
    return this.dataSource.transaction(async (em) => {
      const recRepo = em.getRepository(Reconciliation);
      const txRepo = em.getRepository(BankTransaction);
      const accRepo = em.getRepository(BankAccount);

      const account = await accRepo.findOne({ where: { id: bankAccountId, companyId } });
      if (!account) throw new NotFoundException('Bank account not found');

      const txs = await txRepo.find({
        where: { companyId, bankAccountId, isCleared: false },
        order: { date: 'ASC' },
      });

      for (const tx of txs) {
        if (tx.date <= dto.endDate) {
          tx.isCleared = true;
          tx.clearedDate = new Date();
          await txRepo.save(tx);
        }
      }

      const rec = recRepo.create({
        companyId,
        bankAccountId,
        statementDate: dto.endDate,
        statementBeginningBalance: account.balance,
        statementEndingBalance: dto.endingBalance,
        clearedBalance: account.balance,
        difference: '0',
        status: 'completed',
        completedAt: new Date(),
        completedBy: userId,
      } as any);
      account.lastReconciled = new Date();
      await accRepo.save(account);
      return recRepo.save(rec);
    });
  }

  async listReconciliations(companyId: string, bankAccountId: string, page: number, limit: number) {
    const qb = this.recRepo.createQueryBuilder('r')
      .where('r.companyId = :cid AND r.bankAccountId = :bid', { cid: companyId, bid: bankAccountId })
      .orderBy('r.completedAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }
}
