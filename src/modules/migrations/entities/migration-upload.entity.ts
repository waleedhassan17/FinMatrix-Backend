import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

/**
 * receiving → (all parts in) received → (worker) reading → read | failed.
 * cancelled uploads are deleted, not kept.
 */
export type MigrationUploadStatus =
  | 'receiving'
  | 'received'
  | 'reading'
  | 'read'
  | 'failed';

export interface MigrationUploadProgress {
  stage: 'assembling' | 'unpacking' | 'reading' | 'analysing' | 'done';
  /** What is being worked on: a table name, or bytes so far. */
  detail?: string;
  done?: number;
  total?: number;
}

const bigintAsNumber = {
  to: (v: number | null) => v,
  from: (v: string | null) => (v === null ? null : Number(v)),
};

/**
 * A large file (a Peachtree backup) arriving in pieces. Each piece is its own
 * request, so no request is long, a lost connection costs one piece, and a
 * restarted upload resumes from the pieces the server already holds.
 */
@Entity('migration_uploads')
@Index('IDX_migration_uploads_batch', ['batchId'])
@Index('IDX_migration_uploads_status', ['status', 'updatedAt'])
export class MigrationUpload extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'batch_id' })
  batchId!: string;

  @Column({ type: 'varchar', length: 255, name: 'original_name' })
  originalName!: string;

  @Column({
    type: 'bigint',
    name: 'size_bytes',
    transformer: bigintAsNumber,
  })
  sizeBytes!: number;

  @Column({ type: 'int', name: 'part_size' })
  partSize!: number;

  @Column({ type: 'varchar', length: 16, default: 'receiving' })
  status!: MigrationUploadStatus;

  @Column({ type: 'jsonb', nullable: true })
  progress!: MigrationUploadProgress | null;

  /** Of the whole file, computed by the server as it reads the pieces. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  sha256!: string | null;

  @Column({ type: 'varchar', length: 64, name: 'error_code', nullable: true })
  errorCode!: string | null;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  /** The migration file the backup became once read. */
  @Column({ type: 'uuid', name: 'file_id', nullable: true })
  fileId!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @Column({ type: 'timestamptz', name: 'received_at', nullable: true })
  receivedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'started_at', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'finished_at', nullable: true })
  finishedAt!: Date | null;
}

/** One piece of an upload; deleted once the file has been read. */
@Entity('migration_upload_parts')
export class MigrationUploadPart {
  @PrimaryColumn({ type: 'uuid', name: 'upload_id' })
  uploadId!: string;

  @PrimaryColumn({ type: 'int', name: 'part_no' })
  partNo!: number;

  @Column({ type: 'int', name: 'size_bytes' })
  sizeBytes!: number;

  @Column({ type: 'bytea' })
  data!: Buffer;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
