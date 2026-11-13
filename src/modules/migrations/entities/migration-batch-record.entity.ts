import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

export type BatchRecordType =
  | 'journal_entry'
  | 'invoice'
  | 'bill'
  | 'customer'
  | 'vendor'
  | 'item'
  | 'account'
  | 'movement'
  /** An existing master the batch changed (balance, stock); meta holds the prior values. */
  | 'customer_touched'
  | 'vendor_touched'
  | 'item_touched'
  /** The company's period lock before commit; meta holds the prior lock. */
  | 'company_touched';

/**
 * Every row a committed batch created or changed. Rollback walks this list
 * backwards; the blocker check asks whether anything outside the batch now
 * points at one of these rows.
 */
@Entity('migration_batch_records')
@Index('IDX_migration_batch_records_batch_type', ['batchId', 'recordType'])
@Index('IDX_migration_batch_records_record', ['recordType', 'recordId'])
export class MigrationBatchRecord extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'batch_id' })
  batchId!: string;

  @Column({ type: 'varchar', length: 32, name: 'record_type' })
  recordType!: BatchRecordType;

  @Column({ type: 'uuid', name: 'record_id' })
  recordId!: string;

  @Column({ type: 'jsonb', nullable: true })
  meta!: Record<string, unknown> | null;
}
