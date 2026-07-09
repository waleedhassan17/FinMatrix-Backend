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

  /**
   * Budget vs Actual (QuickBooks flow): actual = net GL movement per account,
   * with the sign driven by the account's normal balance. Returns BOTH the
   * annual comparison and a per-month breakdown (the budget stores 12 monthly
   * amounts, so the report compares month by month). Money math is Decimal —
   * never floats. Read-only: posts nothing.
   */
  async budgetVsActual(companyId: string, id: string) {
    const budget = await this.repo.findOne({ where: { id, companyId }, relations: { lines: true } });
    if (!budget) throw new NotFoundException({ code: 'BUDGET_NOT_FOUND', message: 'Budget not found' });
    const accounts = await this.accountRepo.findByIds(budget.lines.map((l) => l.accountId));
    const accMap = Object.fromEntries(accounts.map((a) => [a.id, a]));
    const from = `${budget.fiscalYear}-01-01`;
    const to = `${budget.fiscalYear}-12-31`;

    const rows = await Promise.all(budget.lines.map(async (l) => {
      // One query per line: per-month debit/credit sums for the fiscal year.
      const monthly = await this.dataSource.query(
        `SELECT EXTRACT(MONTH FROM date)::int AS m,
                COALESCE(SUM(debit::numeric),0) dr, COALESCE(SUM(credit::numeric),0) cr
           FROM general_ledger
          WHERE company_id=$1 AND account_id=$2 AND date BETWEEN $3 AND $4
          GROUP BY 1`,
        [companyId, l.accountId, from, to]);
      const acc = accMap[l.accountId];
      // Expense/asset accounts: debit-positive; revenue/liability: credit-positive.
      const debitNormal = ['expense', 'asset'].includes((acc?.type ?? '').toLowerCase());
      const actualByMonth = Array.from({ length: 12 }, () => new Decimal(0));
      for (const r of monthly) {
        const net = debitNormal
          ? new Decimal(r.dr ?? 0).minus(r.cr ?? 0)
          : new Decimal(r.cr ?? 0).minus(r.dr ?? 0);
        actualByMonth[(r.m ?? 1) - 1] = net;
      }
      const budgetByMonth = (l.monthlyAmounts ?? []).map((v: any) => new Decimal(num(v)));
      while (budgetByMonth.length < 12) budgetByMonth.push(new Decimal(0));

      const months = actualByMonth.map((actualM, i) => ({
        month: i + 1,
        budgeted: budgetByMonth[i].toDecimalPlaces(2).toNumber(),
        actual: actualM.toDecimalPlaces(2).toNumber(),
        variance: budgetByMonth[i].minus(actualM).toDecimalPlaces(2).toNumber(),
      }));

      const actual = actualByMonth.reduce((s, v) => s.plus(v), new Decimal(0));
      const budgeted = new Decimal(num(l.annualTotal));
      return {
        accountId: l.accountId,
        accountCode: acc?.accountNumber ?? '',
        accountName: acc?.name ?? '',
        accountType: acc?.type ?? '',
        budgeted: budgeted.toDecimalPlaces(2).toNumber(),
        actual: actual.toDecimalPlaces(2).toNumber(),
        variance: budgeted.minus(actual).toDecimalPlaces(2).toNumber(),
        percentUsed: budgeted.greaterThan(0)
          ? actual.dividedBy(budgeted).times(100).toDecimalPlaces(1).toNumber()
          : 0,
        months,
      };
    }));

    const totals = rows.reduce(
      (t, r) => ({
        budgeted: t.budgeted.plus(r.budgeted),
        actual: t.actual.plus(r.actual),
        variance: t.variance.plus(r.variance),
      }),
      { budgeted: new Decimal(0), actual: new Decimal(0), variance: new Decimal(0) },
    );
    return {
      budget: { id: budget.id, name: budget.name, fiscalYear: budget.fiscalYear, status: budget.status },
      rows,
      totals: {
        budgeted: totals.budgeted.toDecimalPlaces(2).toNumber(),
        actual: totals.actual.toDecimalPlaces(2).toNumber(),
        variance: totals.variance.toDecimalPlaces(2).toNumber(),
      },
    };
  }

  /**
   * Pre-fill helper (QuickBooks "create budget from previous year's data"):
   * per-account monthly ACTUALS from the ledger for the given fiscal year,
   * for income/expense accounts with activity. The client uses these as the
   * starting monthlyAmounts of a new budget. Read-only — posts nothing.
   */
  async prefillFromActuals(companyId: string, fiscalYear: number) {
    const from = `${fiscalYear}-01-01`;
    const to = `${fiscalYear}-12-31`;
    const rows = await this.dataSource.query(
      `SELECT g.account_id, a.account_number, a.name, a.type,
              COALESCE(SUM(g.debit::numeric),0) dr, COALESCE(SUM(g.credit::numeric),0) cr
         FROM general_ledger g
         JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id=$1 AND g.date BETWEEN $2 AND $3
          AND a.type IN ('income','expense')
        GROUP BY g.account_id, a.account_number, a.name, a.type
        ORDER BY a.account_number`,
      [companyId, from, to],
    );
    // GROUP BY above loses the month split — re-query grouped by month too.
    const monthlyRows = await this.dataSource.query(
      `SELECT g.account_id, EXTRACT(MONTH FROM g.date)::int AS m,
              COALESCE(SUM(g.debit::numeric),0) dr, COALESCE(SUM(g.credit::numeric),0) cr
         FROM general_ledger g
         JOIN accounts a ON a.id = g.account_id
        WHERE g.company_id=$1 AND g.date BETWEEN $2 AND $3
          AND a.type IN ('income','expense')
        GROUP BY g.account_id, EXTRACT(MONTH FROM g.date)`,
      [companyId, from, to],
    );
    const byAccount = new Map<string, Decimal[]>();
    const typeMap = new Map<string, string>(rows.map((r: any) => [r.account_id, r.type]));
    for (const r of monthlyRows) {
      const debitNormal = (typeMap.get(r.account_id) ?? '') === 'expense';
      const net = debitNormal
        ? new Decimal(r.dr ?? 0).minus(r.cr ?? 0)
        : new Decimal(r.cr ?? 0).minus(r.dr ?? 0);
      const arr = byAccount.get(r.account_id) ?? Array.from({ length: 12 }, () => new Decimal(0));
      arr[(r.m ?? 1) - 1] = net;
      byAccount.set(r.account_id, arr);
    }
    return {
      fiscalYear,
      lines: rows.map((r: any) => {
        const months = (byAccount.get(r.account_id) ?? []).map((v) =>
          Decimal.max(v, 0).toDecimalPlaces(2).toNumber(),
        );
        while (months.length < 12) months.push(0);
        return {
          accountId: r.account_id,
          accountCode: r.account_number,
          accountName: r.name,
          accountType: r.type,
          monthlyAmounts: months,
          annualTotal: months.reduce((s, v) => s + v, 0),
        };
      }).filter((l: any) => l.annualTotal > 0),
    };
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
