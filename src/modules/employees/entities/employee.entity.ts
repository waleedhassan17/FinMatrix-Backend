import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { EmployeeStatus, PayFrequency, PayType } from '../../../types';

@Entity('employees')
@Index(['companyId', 'status'])
@Index(['companyId', 'isActive'])
export class Employee extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 120, name: 'first_name' })
  firstName!: string;

  @Column({ type: 'varchar', length: 120, name: 'last_name' })
  lastName!: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  department!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  position!: string | null;

  @Column({ type: 'date', nullable: true, name: 'hire_date' })
  hireDate!: string | null;

  @Column({ type: 'date', nullable: true, name: 'termination_date' })
  terminationDate!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: EmployeeStatus;

  @Column({ type: 'varchar', length: 16, default: 'salary', name: 'pay_type' })
  payType!: PayType;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  salary!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'hourly_rate' })
  hourlyRate!: string;

  @Column({ type: 'varchar', length: 16, default: 'monthly', name: 'pay_frequency' })
  payFrequency!: PayFrequency;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'tax_id' })
  taxId!: string | null;

  @Column({ type: 'jsonb', nullable: true, name: 'bank_account' })
  bankAccount!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true })
  deductions!: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;
}
