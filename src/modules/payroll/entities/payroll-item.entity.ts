import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { PayrollRun } from './payroll-run.entity';

@Entity('payroll_items')
@Index(['payrollRunId'])
export class PayrollItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'payroll_run_id' })
  payrollRunId!: string;

  @Column({ type: 'uuid', name: 'employee_id' })
  employeeId!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'hours' })
  hours!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  gross!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  deductions!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  net!: string;

  @ManyToOne(() => PayrollRun, (r) => r.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'payroll_run_id' })
  payrollRun!: PayrollRun;
}
