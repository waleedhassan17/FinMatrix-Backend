import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';
import { UserCompany } from './user-company.entity';

export interface CompanyAddress {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

@Entity('companies')
export class Company extends BaseEntity {
  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  industry!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  address!: CompanyAddress | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'tax_id' })
  taxId!: string | null;

  // ── QuickBooks-style onboarding fields (Stage 1) ──────────────────────────
  @Column({
    type: 'varchar',
    length: 32,
    nullable: true,
    name: 'legal_structure',
  })
  legalStructure!: string | null; // sole_proprietor | llc | partnership | corporation

  @Column({ type: 'varchar', length: 255, nullable: true })
  website!: string | null;

  @Column({
    type: 'smallint',
    nullable: true,
    name: 'fiscal_year_start_month',
  })
  fiscalYearStartMonth!: number | null; // 1-12 (1 = January)

  @Column({
    type: 'varchar',
    length: 16,
    nullable: true,
    name: 'accounting_method',
  })
  accountingMethod!: string | null; // cash | accrual

  @Column({
    type: 'varchar',
    length: 8,
    nullable: true,
    name: 'home_currency',
  })
  homeCurrency!: string | null; // ISO 4217, e.g. PKR, USD

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 16, name: 'invite_code' })
  inviteCode!: string;

  @Column({ type: 'text', nullable: true })
  logo!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @Column({ type: 'varchar', length: 20, default: 'active', nullable: true })
  status!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'submitted_at' })
  submittedAt!: Date | null;

  @Column({ type: 'text', nullable: true, name: 'rejection_reason' })
  rejectionReason!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'reviewed_by' })
  reviewedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'reviewed_at' })
  reviewedAt!: Date | null;

  @Column({ type: 'boolean', default: false, name: 'setup_completed' })
  setupCompleted!: boolean;

  @OneToMany(() => UserCompany, (uc) => uc.company)
  memberships!: UserCompany[];
}
