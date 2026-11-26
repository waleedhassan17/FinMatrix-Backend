import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';

export type CompanyDeletionStatus =
  | 'pending'
  | 'backing_up'
  | 'deleting'
  | 'done'
  | 'failed';

/**
 * One permanent company deletion — the job and its record. Deliberately NOT
 * company data: company_id has no foreign key and the name is copied, so the
 * record outlives the company. The owner's email is kept only as a SHA-256.
 */
@Entity('company_deletions')
@Index('idx_company_deletions_status', ['status', 'createdAt'])
@Index('ux_company_deletions_live', ['companyId'], {
  unique: true,
  where: `"status" IN ('pending', 'backing_up', 'deleting')`,
})
export class CompanyDeletion extends BaseEntity {
  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'varchar', length: 200, name: 'company_name' })
  companyName!: string;

  @Column({ type: 'uuid', name: 'requested_by' })
  requestedBy!: string;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ type: 'boolean', name: 'allow_new_trial', default: false })
  allowNewTrial!: boolean;

  @Column({ type: 'boolean', name: 'is_demo', default: false })
  isDemo!: boolean;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: CompanyDeletionStatus;

  @Column({ type: 'boolean', name: 'backup_required', default: false })
  backupRequired!: boolean;

  @Column({ type: 'uuid', name: 'final_backup_id', nullable: true })
  finalBackupId!: string | null;

  @Column({ type: 'jsonb', name: 'row_counts', nullable: true })
  rowCounts!: Record<string, number> | null;

  @Column({ type: 'integer', name: 'files_deleted', default: 0 })
  filesDeleted!: number;

  @Column({ type: 'integer', name: 'files_failed', default: 0 })
  filesFailed!: number;

  @Column({ type: 'integer', name: 'users_deleted', default: 0 })
  usersDeleted!: number;

  @Column({ type: 'integer', name: 'memberships_removed', default: 0 })
  membershipsRemoved!: number;

  @Column({
    type: 'varchar',
    length: 64,
    name: 'owner_email_hash',
    nullable: true,
  })
  ownerEmailHash!: string | null;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'timestamptz', name: 'started_at', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'finished_at', nullable: true })
  finishedAt!: Date | null;
}
