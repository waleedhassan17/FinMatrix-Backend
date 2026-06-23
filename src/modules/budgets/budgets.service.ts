import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import Decimal from 'decimal.js';
import { Budget, BudgetStatus } from './entities/budget.entity';
import { BudgetLine } from './entities/budget-line.entity';
import { Account } from '../accounts/entities/account.entity';
import { CreateBudgetDto, ListBudgetsQueryDto, UpdateBudgetDto, BudgetLineDto } from './dto/budget.dto';

const num = (v: any) => parseFloat(v ?? '0') || 0;

@Injectable()
export class BudgetsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Budget) private readonly repo: Repository<Budget>,
    @InjectRepository(Account) private readonly accountRepo: Repository<Account>,
  ) {}

  async list(companyId: string, query: ListBudgetsQueryDto) {
    const qb = this.repo.createQueryBuilder('b').where('b.companyId = :companyId', { companyId });
    if (query.fiscalYear) qb.andWhere('b.fiscalYear = :fy', { fy: query.fiscalYear });
    qb.orderBy('b.fiscalYear', 'DESC').addOrderBy('b.createdAt', 'DESC');
    const data = await qb.getMany();
    return { data };
  }

  async getById(companyId: string, id: string) {
    const budget = await this.repo.findOne({ where: { id, companyId }, relations: { lines: true } });
    if (!budget) throw new NotFoundException({ code: 'BUDGET_NOT_FOUND', message: 'Budget not found' });
    const accounts = await this.accountRepo.findByIds(budget.lines.map((l) => l.accountId));
    const accMap = Object.fromEntries(accounts.map((a) => [a.id, a]));
    return {
      ...budget,
      lines: budget.lines.map((l) => ({
        ...l,
        accountCode: accMap[l.accountId]?.accountNumber ?? '',
        accountName: accMap[l.accountId]?.name ?? '',
      })),
    };
  }

  async create(companyId: string, userId: string, dto: CreateBudgetDto): Promise<Budget> {
    return this.dataSource.transaction(async (manager) => {
      const { lines, totalBudget } = this.computeLines(dto.lines);
      const budget = manager.create(Budget, {
        companyId, name: dto.name, fiscalYear: dto.fiscalYear,
        status: (dto.status ?? 'draft') as BudgetStatus, totalBudget, createdBy: userId,
      });
      await manager.save(budget);
      budget.lines = lines.map((l) => manager.create(BudgetLine, { budgetId: budget.id, ...l }));
      await manager.save(budget.lines);
      return budget;
    });
  }

  async update(companyId: string, id: string, dto: UpdateBudgetDto): Promise<Budget> {
    return this.dataSource.transaction(async (manager) => {
      const budget = await manager.findOne(Budget, { where: { id, companyId }, relations: { lines: true } });
      if (!budget) throw new NotFoundException({ code: 'BUDGET_NOT_FOUND', message: 'Budget not found' });
      if (dto.name !== undefined) budget.name = dto.name;
      if (dto.status !== undefined) budget.status = dto.status as BudgetStatus;
      if (dto.lines) {
        const { lines, totalBudget } = this.computeLines(dto.lines);
        budget.totalBudget = totalBudget;
        await manager.delete(BudgetLine, { budgetId: budget.id });
        await manager.save(lines.map((l) => manager.create(BudgetLine, { budgetId: budget.id, ...l })));
      }
      await manager.save(budget);
      return (await manager.findOne(Budget, { where: { id, companyId }, relations: { lines: true } }))!;
    });
  }

  async delete(companyId: string, id: string) {
    const budget = await this.repo.findOne({ where: { id, companyId } });
    if (!budget) throw new NotFoundException({ code: 'BUDGET_NOT_FOUND', message: 'Budget not found' });
    await this.repo.remove(budget);
    return { id, deleted: true };
  }

  /** Budget vs Actual: actual = net GL movement per account within the fiscal year. */
  async budgetVsActual(companyId: string, id: string) {
    const budget = await this.repo.findOne({ where: { id, companyId }, relations: { lines: true } });
    if (!budget) throw new NotFoundException({ code: 'BUDGET_NOT_FOUND', message: 'Budget not found' });
    const accounts = await this.accountRepo.findByIds(budget.lines.map((l) => l.accountId));
    const accMap = Object.fromEntries(accounts.map((a) => [a.id, a]));
    const from = `${budget.fiscalYear}-01-01`;
    const to = `${budget.fiscalYear}-12-31`;

    const rows = await Promise.all(budget.lines.map(async (l) => {
      const r = await this.dataSource.query(
        `SELECT COALESCE(SUM(debit::numeric),0) dr, COALESCE(SUM(credit::numeric),0) cr
         FROM general_ledger WHERE company_id=$1 AND account_id=$2 AND date BETWEEN $3 AND $4`,
        [companyId, l.accountId, from, to]);
      const acc = accMap[l.accountId];
      // Expense/asset accounts: debit-positive; revenue/liability: credit-positive.
      const debitNormal = ['expense', 'asset'].includes((acc?.type ?? '').toLowerCase());
      const actual = debitNormal ? num(r[0].dr) - num(r[0].cr) : num(r[0].cr) - num(r[0].dr);
      const budgeted = num(l.annualTotal);
      return {
        accountId: l.accountId,
        accountCode: acc?.accountNumber ?? '',
        accountName: acc?.name ?? '',
        accountType: acc?.type ?? '',
        budgeted: Math.round(budgeted * 100) / 100,
        actual: Math.round(actual * 100) / 100,
        variance: Math.round((budgeted - actual) * 100) / 100,
        percentUsed: budgeted > 0 ? Math.round((actual / budgeted) * 1000) / 10 : 0,
      };
    }));

    const totals = rows.reduce((t, r) => ({
      budgeted: t.budgeted + r.budgeted, actual: t.actual + r.actual, variance: t.variance + r.variance,
    }), { budgeted: 0, actual: 0, variance: 0 });
    Object.keys(totals).forEach((k) => ((totals as any)[k] = Math.round((totals as any)[k] * 100) / 100));
    return { budget: { id: budget.id, name: budget.name, fiscalYear: budget.fiscalYear, status: budget.status }, rows, totals };
  }

  private computeLines(lines: BudgetLineDto[]) {
    let totalBudget = new Decimal(0);
    const computed = lines.map((l) => {
      const monthly = Array.from({ length: 12 }, (_, i) => num(l.monthlyAmounts?.[i]));
      const annual = monthly.reduce((s, v) => s.plus(v), new Decimal(0));
      totalBudget = totalBudget.plus(annual);
      return { accountId: l.accountId, monthlyAmounts: monthly, annualTotal: annual.toFixed(4) };
    });
    return { lines: computed, totalBudget: totalBudget.toFixed(4) };
  }
}
