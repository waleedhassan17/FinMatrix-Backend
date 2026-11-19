import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

/**
 *   sheet   — a source sheet → a target sheet key          (source = sheet name)
 *   column  — a source header → a target field             (within `sheet`)
 *   value   — a source value → a target value              (field in `sheet`,
 *             e.g. account type "Debtors" → 'asset'; source = `field::value`)
 *   account — a source account number → FinMatrix account number, or 'NEW'
 */
export type MappingKind =
  | 'sheet'
  | 'column'
  | 'value'
  | 'account'
  /** Owner decisions that resolve an issue rather than map a column. */
  | 'match'
  | 'cell'
  | 'skip';
export type MappingOrigin = 'profile' | 'rule' | 'ai' | 'user';

/** Below this a mapping is a question for the owner, never a silent default. */
export const MAPPING_CONFIDENT = 0.9;

@Entity('migration_mappings')
@Index(
  'UQ_migration_mappings_batch_kind_sheet_source',
  ['batchId', 'kind', 'sheet', 'source'],
  { unique: true },
)
export class MigrationMapping extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'batch_id' })
  batchId!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: MappingKind;

  /** Empty string for a mapping that is not sheet-scoped (account mappings). */
  @Column({ type: 'varchar', length: 64, default: '' })
  sheet!: string;

  @Column({ type: 'varchar', length: 255 })
  source!: string;

  /** Null when nothing could be proposed — always paired with an issue. */
  @Column({ type: 'varchar', length: 128, nullable: true })
  target!: string | null;

  @Column({ type: 'numeric', precision: 4, scale: 3, default: 0 })
  confidence!: string;

  @Column({ type: 'varchar', length: 8 })
  origin!: MappingOrigin;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'boolean', default: false })
  confirmed!: boolean;
}
