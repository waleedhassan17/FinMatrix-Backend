import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { PayrollItem } from './payroll-item.entity';

export type PayrollStatus = 'draft' | 'processed' | 'paid';

@Entity('payroll_runs')
@Index(['companyId', 'status'])
export class PayrollRun extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 64, name: 'pay_period' })
  payPeriod!: string;

  @Column({ type: 'date', name: 'period_start' })
  periodStart!: string;

  @Column({ type: 'date', name: 'period_end' })
  periodEnd!: string;

  @Column({ type: 'date', name: 'pay_date' })
  payDate!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'total_gross' })
  totalGross!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'total_deductions' })
  totalDeductions!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'total_net' })
  totalNet!: string;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: PayrollStatus;

  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @OneToMany(() => PayrollItem, (i) => i.payrollRun, { cascade: true })
  items!: PayrollItem[];
}
