import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

@Entity('general_ledger')
@Index(['companyId', 'date'])
@Index(['companyId', 'accountId', 'date'])
export class GeneralLedgerEntry extends BaseCompanyEntity {
  @Column({ type: 'date' })
  date!: string;

  @Column({ type: 'varchar', length: 32 })
  reference!: string;

  @Column({ type: 'uuid', name: 'account_id' })
  accountId!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  debit!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  credit!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  balance!: string;

  @Column({ type: 'varchar', length: 32, name: 'source_type' })
  sourceType!: string;

  @Column({ type: 'uuid', name: 'source_id' })
  sourceId!: string;

  @Column({ type: 'text', nullable: true })
  memo!: string | null;

  // Bank reconciliation (FinMatrix.md §27). `cleared` = ticked as appearing on
  // a bank statement; `reconciliationId` links the row to a finalised
  // reconciliation (its "reconciled" marker). Neither posts to the ledger.
  @Column({ type: 'boolean', default: false })
  cleared!: boolean;

  @Index()
  @Column({ type: 'uuid', name: 'reconciliation_id', nullable: true })
  reconciliationId!: string | null;
}
