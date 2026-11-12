import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

/**
 *   queued  → running → ready  → expired   (file deleted after retention)
 *                     ↘ failed             (`error` says why; re-request)
 */
export type CompanyExportStatus =
  | 'queued'
  | 'running'
  | 'ready'
  | 'failed'
  | 'expired';

/** Per-entity row counts the worker records, for the list view and the PR. */
export interface CompanyExportSummary {
  entities: Record<string, number>;
  attachments: number;
  reports: string[];
  durationMs: number;
}

/**
 * One backup an owner asked for. The row IS the job: the worker claims it,
 * builds the ZIP and writes the outcome back here (see the migration
 * CompanyExports for the lifecycle).
 */
@Entity('company_exports')
@Index('IDX_company_exports_company_created', ['companyId', 'createdAt'])
@Index('IDX_company_exports_status_created', ['status', 'createdAt'])
export class CompanyExport extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'requested_by' })
  requestedBy!: string;

  @Column({ type: 'varchar', length: 16, default: 'queued' })
  status!: CompanyExportStatus;

  @Column({ type: 'boolean', default: false, name: 'include_xlsx' })
  includeXlsx!: boolean;

  /** The business day the backup describes; also in the file name. */
  @Column({ type: 'date', name: 'as_of' })
  asOf!: string;

  @Column({ type: 'varchar', length: 160, name: 'file_name' })
  fileName!: string;

  @Column({ type: 'varchar', length: 255, nullable: true, name: 'storage_key' })
  storageKey!: string | null;

  // bigint: pg returns it as a string, and a backup with photos is well past
  // what a 32-bit integer holds.
  @Column({ type: 'bigint', nullable: true, name: 'size_bytes' })
  sizeBytes!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'jsonb', nullable: true })
  summary!: CompanyExportSummary | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'started_at' })
  startedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'expires_at' })
  expiresAt!: Date | null;
}
