import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, DataSource } from 'typeorm';
import { Budget } from './entities/budget.entity';
import { BudgetLine } from './entities/budget-line.entity';
import { CreateBudgetDto, UpdateBudgetDto } from './dto/budget.dto';

@Injectable()
export class BudgetsService {
  constructor(
    @InjectRepository(Budget) private readonly budgetRepo: Repository<Budget>,
    @InjectRepository(BudgetLine) private readonly lineRepo: Repository<BudgetLine>,
    private readonly dataSource: DataSource,
  ) {}

  async list(companyId: string, page: number, limit: number) {
    const qb = this.budgetRepo.createQueryBuilder('b').where('b.companyId = :cid', { cid: companyId });
    qb.orderBy('b.createdAt', 'DESC');
    qb.skip((page - 1) * limit).take(limit);
    const [data, total] = await qb.getManyAndCount();
    return { data, total, page, limit };
  }

  async getById(companyId: string, id: string) {
    const b = await this.budgetRepo.findOne({ where: { id, companyId }, relations: ['lines'] });
    if (!b) throw new NotFoundException('Budget not found');
    return b;
  }

  async create(companyId: string, dto: CreateBudgetDto, userId: string) {
    return this.dataSource.transaction(async (em) => {
      const budgetRepo = em.getRepository(Budget);
      const lineRepo = em.getRepository(BudgetLine);
      const budget = Object.assign(new Budget(), {
        companyId,
        name: dto.name,
        fiscalYear: dto.fiscalYear,
        status: dto.status ?? 'draft',
        totalBudget: dto.totalBudget,
        createdBy: userId,
      } as any);
      await budgetRepo.save(budget);

      const lines = dto.lines.map((l) => Object.assign(new BudgetLine(), {
        budgetId: budget.id,
        accountId: l.accountId,
        annualTotal: l.annualTotal,
        monthlyAmounts: l.monthlyAmounts ?? [],
      } as any));
      await lineRepo.save(lines);
      return { ...budget, lines };
    });
  }

  async update(companyId: string, id: string, dto: UpdateBudgetDto) {
    const b = await this.getById(companyId, id);
    Object.assign(b, dto);
    return this.budgetRepo.save(b);
  }

  async remove(companyId: string, id: string) {
    const b = await this.getById(companyId, id);
    await this.budgetRepo.softRemove(b);
    return { id, deleted: true };
  }
}
