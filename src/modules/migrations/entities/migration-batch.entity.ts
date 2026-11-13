import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

/**
 *   draft → uploaded → mapped → validated → ready → committed → closed
 *                                        ↘ (any fix) → mapped
 *   committed → rolled_back
 */
export type MigrationStatus =
  | 'draft'
  | 'uploaded'
  | 'mapped'
  | 'validated'
  | 'ready'
  | 'committed'
  | 'closed'
  | 'rolled_back';

export type MigrationSourceSystem =
  | 'finmatrix_template'
  | 'generic_spreadsheet'
  | 'tally'
  | 'peachtree'
  | 'quickbooks_online'
  | 'xero'
  | 'odoo';

export const MIGRATION_SOURCE_SYSTEMS: MigrationSourceSystem[] = [
  'finmatrix_template',
  'generic_spreadsheet',
  'tally',
  'peachtree',
  'quickbooks_online',
  'xero',
  'odoo',
];

/** One of the nine hard checks, as last computed. Amounts are strings. */
export interface MigrationCheckResult {
  code: string;
  label: string;
  expected: string;
  actual: string;
  difference: string;
  passed: boolean;
  details: Array<Record<string, unknown>>;
}

export interface MigrationCounts {
  /** Per entity type: source rows and their outcomes. */
  rows: Record<
    string,
    {
      source: number;
      imported: number;
      merged: number;
      rejected: number;
      pending: number;
    }
  >;
  issues: { blocking: number; warning: number; resolved: number };
  mappings: { total: number; confident: number };
}

@Entity('migration_batches')
@Index('IDX_migration_batches_company_created', ['companyId', 'createdAt'])
export class MigrationBatch extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 32, name: 'source_system' })
  sourceSystem!: MigrationSourceSystem;

  /** Every migration posting is dated this day. */
  @Column({ type: 'date', name: 'cutover_date' })
  cutoverDate!: string;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: MigrationStatus;

  /** 0–100, floored. Import requires 100. */
  @Column({ type: 'int', default: 0 })
  readiness!: number;

  @Column({ type: 'jsonb', nullable: true })
  checks!: MigrationCheckResult[] | null;

  @Column({ type: 'jsonb', nullable: true })
  counts!: MigrationCounts | null;

  @Column({ type: 'text', nullable: true, name: 'last_error' })
  lastError!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @Column({ type: 'uuid', nullable: true, name: 'signed_off_by' })
  signedOffBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'signed_off_at' })
  signedOffAt!: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'committed_by' })
  committedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'committed_at' })
  committedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'closed_at' })
  closedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'rolled_back_at' })
  rolledBackAt!: Date | null;

  @Column({
    type: 'varchar',
    length: 255,
    nullable: true,
    name: 'certificate_storage_key',
  })
  certificateStorageKey!: string | null;

  /** The period lock before commit, restored by rollback. */
  @Column({ type: 'date', nullable: true, name: 'previous_books_locked_until' })
  previousBooksLockedUntil!: string | null;

  @Column({ type: 'int', default: 0, name: 'ai_calls' })
  aiCalls!: number;

  @Column({ type: 'int', default: 0, name: 'ai_input_tokens' })
  aiInputTokens!: number;

  @Column({ type: 'int', default: 0, name: 'ai_output_tokens' })
  aiOutputTokens!: number;
}
