import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { BudgetStatus } from '../../../types';
import { BudgetLine } from './budget-line.entity';

@Entity('budgets')
@Index(['companyId', 'fiscalYear'])
export class Budget extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'int', name: 'fiscal_year' })
  fiscalYear!: number;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: BudgetStatus;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'total_budget' })
  totalBudget!: string;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @OneToMany(() => BudgetLine, (l) => l.budget, { cascade: true })
  lines!: BudgetLine[];
}
