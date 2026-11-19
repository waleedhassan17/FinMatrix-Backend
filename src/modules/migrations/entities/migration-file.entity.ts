import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

/**
 * 'ptb' is a Peachtree / Sage 50 backup. Its original is not kept: it is read
 * once (sources/peachtree) and `storageKey` holds what was read from it — a
 * small JSON extract — while name, size and sha256 describe the backup as
 * uploaded.
 */
/** 'extract': a large export already read by the background reader (its sheets, as JSON). */
export type MigrationFileKind =
  | 'xlsx'
  | 'csv'
  | 'zip'
  | 'xml'
  | 'ptb'
  | 'extract';

export interface DetectedSheet {
  /** Sheet name inside the file (or the file name for a CSV). */
  sheet: string;
  /** Target sheet key it was read as, or null when not recognised. */
  target: string | null;
  confidence: number;
  rows: number;
  headers: string[];
}

/** An uploaded original, kept exactly as received. */
@Entity('migration_files')
@Index('IDX_migration_files_batch', ['batchId'])
export class MigrationFile extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'batch_id' })
  batchId!: string;

  @Column({ type: 'varchar', length: 255, name: 'original_name' })
  originalName!: string;

  @Column({ type: 'varchar', length: 128, name: 'mime_type' })
  mimeType!: string;

  @Column({
    type: 'bigint',
    name: 'size_bytes',
    transformer: {
      to: (v: number) => v,
      from: (v: string | null) => (v === null ? null : Number(v)),
    },
  })
  sizeBytes!: number;

  @Column({ type: 'varchar', length: 255, name: 'storage_key' })
  storageKey!: string;

  @Column({ type: 'varchar', length: 64 })
  sha256!: string;

  @Column({ type: 'varchar', length: 16 })
  kind!: MigrationFileKind;

  @Column({ type: 'jsonb', nullable: true })
  detected!: DetectedSheet[] | null;
}
