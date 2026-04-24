import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { ReconciliationStatus } from '../../../types';

@Entity('reconciliations')
@Index(['companyId', 'bankAccountId'])
@Index(['companyId', 'status'])
export class Reconciliation extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'bank_account_id' })
  bankAccountId!: string;

  @Column({ type: 'date', name: 'statement_date' })
  statementDate!: string;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'statement_beginning_balance',
  })
  statementBeginningBalance!: string;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'statement_ending_balance',
  })
  statementEndingBalance!: string;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'cleared_balance',
  })
  clearedBalance!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  difference!: string;

  @Column({ type: 'varchar', length: 16, default: 'in_progress' })
  status!: ReconciliationStatus;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'completed_by' })
  completedBy!: string | null;
}
