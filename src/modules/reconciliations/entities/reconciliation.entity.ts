import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

/**
 * A finalised bank reconciliation (FinMatrix.md §27). Records the statement the
 * book cash/bank ledger was matched against and the cleared balance that tied
 * out to it. This is a verification/marking process — it posts NO journal
 * entries; corrections are entered as normal transactions.
 */
@Entity('reconciliations')
@Index(['companyId', 'accountId', 'statementDate'])
export class Reconciliation extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'account_id' })
  accountId!: string;

  @Column({ type: 'date', name: 'statement_date' })
  statementDate!: string;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    name: 'statement_ending_balance',
  })
  statementEndingBalance!: string;

  // Reconciled balance carried in from prior reconciliations (sum of all
  // previously-reconciled rows for the account).
  @Column({ type: 'decimal', precision: 18, scale: 4, name: 'beginning_balance', default: 0 })
  beginningBalance!: string;

  // Beginning balance + net of the rows cleared in this session.
  @Column({ type: 'decimal', precision: 18, scale: 4, name: 'cleared_balance', default: 0 })
  clearedBalance!: string;

  // statementEndingBalance − clearedBalance (must be ~0 to finalise).
  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  difference!: string;

  @Column({ type: 'int', name: 'cleared_count', default: 0 })
  clearedCount!: number;

  @Column({ type: 'varchar', length: 16, default: 'completed' })
  status!: string;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @Column({ type: 'timestamptz', name: 'reconciled_at', nullable: true })
  reconciledAt!: Date | null;
}
