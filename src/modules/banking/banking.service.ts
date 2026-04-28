import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { BankAccount } from './entities/bank-account.entity';
import { BankTransaction } from './entities/bank-transaction.entity';
import { Reconciliation } from './entities/reconciliation.entity';
import { CreateBankAccountDto, UpdateBankAccountDto, CreateBankTransactionDto, ReconcileDto, BankAccountQueryDto, BankTransactionQueryDto, CreateTransferDto } from './dto/banking.dto';
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

  async listAllTransactions(companyId: string, query: BankTransactionQueryDto, page: number, limit: number) {
    const qb = this.txRepo.createQueryBuilder('t').where('t.companyId = :cid', { cid: companyId });
    if (query.bankAccountId) {
      qb.andWhere('t.bankAccountId = :bid', { bid: query.bankAccountId });
    }
    if (query.isReconciled !== undefined) {
      qb.andWhere('t.isCleared = :cleared', { cleared: query.isReconciled });
    }
    qb.orderBy('t.date', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async listUnreconciledTransactions(companyId: string, bankAccountId?: string) {
    const qb = this.txRepo.createQueryBuilder('t')
      .where('t.companyId = :cid AND t.isCleared = false', { cid: companyId })
      .orderBy('t.date', 'ASC');
    if (bankAccountId) {
      qb.andWhere('t.bankAccountId = :bid', { bid: bankAccountId });
    }
    const data = await qb.getMany();
    return { data, total: data.length };
  }

  async createTransfer(companyId: string, dto: CreateTransferDto, userId: string) {
    return this.dataSource.transaction(async (em) => {
      const accRepo = em.getRepository(BankAccount);
      const txRepo = em.getRepository(BankTransaction);

      const fromAccount = await accRepo.findOne({ where: { id: dto.fromAccountId, companyId } });
      const toAccount = await accRepo.findOne({ where: { id: dto.toAccountId, companyId } });

      if (!fromAccount || !toAccount) {
        throw new NotFoundException('One or both bank accounts not found');
      }

      const amount = toDecimal(dto.amount);
      const fromBalance = toDecimal(fromAccount.balance).minus(amount);
      const toBalance = toDecimal(toAccount.balance).plus(amount);

      fromAccount.balance = fromBalance.toFixed(4);
      toAccount.balance = toBalance.toFixed(4);

      await accRepo.save([fromAccount, toAccount]);

      const fromTx = txRepo.create({
        companyId,
        bankAccountId: dto.fromAccountId,
        date: dto.date,
        type: 'transfer' as any,
        payee: toAccount.name,
        amount: dto.amount,
        balance: fromBalance.toFixed(4),
        memo: dto.memo ?? 'Outgoing transfer',
        isCleared: false,
      } as any);

      const toTx = txRepo.create({
        companyId,
        bankAccountId: dto.toAccountId,
        date: dto.date,
        type: 'transfer' as any,
        payee: fromAccount.name,
        amount: dto.amount,
        balance: toBalance.toFixed(4),
        memo: dto.memo ?? 'Incoming transfer',
        isCleared: false,
      } as any);

      await txRepo.save(fromTx);
      await txRepo.save(toTx);

      return { fromTransaction: fromTx, toTransaction: toTx, journalEntry: null };
    });
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

      let difference = toDecimal(dto.endingBalance).minus(toDecimal(dto.beginningBalance));

      if (dto.clearedTransactionIds && dto.clearedTransactionIds.length > 0) {
        const txs = await txRepo.createQueryBuilder('t')
          .where('t.companyId = :cid AND t.bankAccountId = :bid AND t.id IN (:...ids)', { 
            cid: companyId, 
            bid: bankAccountId,
            ids: dto.clearedTransactionIds 
          }).getMany();

        for (const tx of txs) {
          tx.isCleared = true;
          tx.clearedDate = new Date();
          
          if (tx.type === 'expense' || tx.type === 'fee' || tx.type === 'check') {
             difference = difference.plus(toDecimal(tx.amount));
          } else {
             difference = difference.minus(toDecimal(tx.amount));
          }
        }
        await txRepo.save(txs);
      }

      const rec = recRepo.create({
        companyId,
        bankAccountId,
        statementDate: dto.statementDate,
        statementBeginningBalance: dto.beginningBalance,
        statementEndingBalance: dto.endingBalance,
        clearedBalance: account.balance,
        difference: difference.toFixed(4),
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
