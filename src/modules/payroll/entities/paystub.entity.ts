import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PayrollRun } from './payroll-run.entity';

@Entity('paystubs')
@Index(['payrollRunId'])
@Index(['employeeId'])
export class Paystub {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'payroll_run_id' })
  payrollRunId!: string;

  @Column({ type: 'uuid', name: 'employee_id' })
  employeeId!: string;

  @Column({
    type: 'decimal',
    precision: 10,
    scale: 2,
    default: 0,
    name: 'hours_worked',
  })
  hoursWorked!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'gross_pay' })
  grossPay!: string;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'tax_deduction',
  })
  taxDeduction!: string;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'health_insurance_deduction',
  })
  healthInsuranceDeduction!: string;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'retirement_deduction',
  })
  retirementDeduction!: string;

  @Column({ type: 'jsonb', nullable: true, name: 'other_deductions' })
  otherDeductions!: Record<string, unknown> | null;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'net_pay' })
  netPay!: string;

  @Column({ type: 'jsonb', nullable: true })
  adjustments!: Record<string, unknown> | null;

  @ManyToOne(() => PayrollRun, (p) => p.paystubs, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'payroll_run_id' })
  payrollRun!: PayrollRun;
}
