import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

export type MigrationFileKind = 'xlsx' | 'csv' | 'zip' | 'xml';

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

  @Column({ type: 'int', name: 'size_bytes' })
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
