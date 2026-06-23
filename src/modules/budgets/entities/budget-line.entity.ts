import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { Budget } from './budget.entity';

@Entity('budget_lines')
@Index(['budgetId'])
export class BudgetLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'budget_id' })
  budgetId!: string;

  @Column({ type: 'uuid', name: 'account_id' })
  accountId!: string;

  /** 12 monthly figures (Jan..Dec). */
  @Column({ type: 'jsonb', name: 'monthly_amounts' })
  monthlyAmounts!: number[];

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'annual_total' })
  annualTotal!: string;

  @ManyToOne(() => Budget, (b) => b.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'budget_id' })
  budget!: Budget;
}
