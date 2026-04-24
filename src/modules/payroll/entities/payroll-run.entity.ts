import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { PayrollRunStatus } from '../../../types';
import { Paystub } from './paystub.entity';

@Entity('payroll_runs')
@Index(['companyId', 'payDate'])
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

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'total_deductions',
  })
  totalDeductions!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'total_net' })
  totalNet!: string;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: PayrollRunStatus;

  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @OneToMany(() => Paystub, (p) => p.payrollRun, { cascade: true })
  paystubs!: Paystub[];
}
