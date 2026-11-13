import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

/** The target sheets of the starter workbook (§1.5), which every source maps into. */
export type MigrationEntityType =
  | 'accounts'
  | 'customers'
  | 'vendors'
  | 'items'
  | 'trial_balance'
  | 'open_invoices'
  | 'open_bills'
  | 'stock';

export const MIGRATION_ENTITY_TYPES: MigrationEntityType[] = [
  'accounts',
  'customers',
  'vendors',
  'items',
  'trial_balance',
  'open_invoices',
  'open_bills',
  'stock',
];

/**
 *   pending  — read, not yet decided
 *   imported — will create (or did create) a record
 *   merged   — matched an existing record, or merged into another row
 *   rejected — will not be imported; `reason` says why
 */
export type StagingOutcome = 'pending' | 'imported' | 'merged' | 'rejected';

export interface StagingMatch {
  /** Existing FinMatrix record the row maps to, when any. */
  recordId?: string;
  /** How it was matched. */
  by?: 'code' | 'name' | 'number' | 'user';
  /** Another staging row this one was merged into (duplicates in the files). */
  mergedIntoRowId?: string;
}

/**
 * One source row. `raw` is the row exactly as read, keyed by the source
 * header; `normalized` is the row as understood, keyed by the target field
 * with amounts as decimal strings and dates as ISO. The two together are how
 * "rows accounted for" and "round trip" can be proved later.
 */
@Entity('migration_staging_rows')
@Index('IDX_migration_staging_batch_entity', ['batchId', 'entityType'])
@Index('IDX_migration_staging_batch_sheet_row', [
  'batchId',
  'sheet',
  'rowNumber',
])
export class MigrationStagingRow extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'batch_id' })
  batchId!: string;

  @Column({ type: 'uuid', nullable: true, name: 'file_id' })
  fileId!: string | null;

  @Column({ type: 'varchar', length: 64 })
  sheet!: string;

  /** The row number the user sees in Excel (1-based, header included). */
  @Column({ type: 'int', name: 'row_number' })
  rowNumber!: number;

  @Column({ type: 'varchar', length: 64, name: 'row_hash' })
  rowHash!: string;

  @Column({ type: 'varchar', length: 32, nullable: true, name: 'entity_type' })
  entityType!: MigrationEntityType | null;

  @Column({ type: 'jsonb' })
  raw!: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  normalized!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  outcome!: StagingOutcome;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  match!: StagingMatch | null;
}
