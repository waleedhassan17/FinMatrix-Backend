import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

export type IssueSeverity = 'blocking' | 'warning';

export interface IssueOption {
  /** What the resolution `value` should be to choose this option. */
  value: string;
  label: string;
}

export interface IssueResolution {
  action: 'edit' | 'map' | 'skip';
  value?: string | null;
  reason?: string | null;
  by: string;
  at: string;
}

/**
 * Something the owner has to decide before the books can be imported. Every
 * uncertain mapping, unparseable amount, unknown party and duplicate becomes
 * one of these — never a silent default.
 */
@Entity('migration_issues')
@Index('IDX_migration_issues_batch_code', ['batchId', 'code'])
@Index('IDX_migration_issues_batch_resolved', ['batchId', 'resolvedAt'])
export class MigrationIssue extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'batch_id' })
  batchId!: string;

  @Column({ type: 'varchar', length: 48 })
  code!: string;

  @Column({ type: 'varchar', length: 8 })
  severity!: IssueSeverity;

  @Column({ type: 'varchar', length: 64, nullable: true })
  sheet!: string | null;

  @Column({ type: 'int', nullable: true, name: 'row_number' })
  rowNumber!: number | null;

  @Column({ type: 'varchar', length: 64, nullable: true })
  field!: string | null;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'jsonb', nullable: true })
  options!: IssueOption[] | null;

  @Column({ type: 'jsonb', nullable: true })
  resolution!: IssueResolution | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'resolved_at' })
  resolvedAt!: Date | null;
}
