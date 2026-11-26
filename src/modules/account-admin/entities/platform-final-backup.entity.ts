import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from '../../../common/base/base.entity';

/**
 * The automatic final backup taken before a company with posted journal
 * entries is deleted. Kept for DELETION_BACKUP_RETENTION_DAYS (default 30),
 * downloadable by super-admins only, then deleted by the cleanup sweep.
 * Platform-owned: it survives the company it is a copy of.
 */
@Entity('platform_final_backups')
@Index('idx_platform_final_backups_expiry', ['expiresAt'])
export class PlatformFinalBackup extends BaseEntity {
  @Column({ type: 'uuid', name: 'deletion_id' })
  deletionId!: string;

  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'varchar', length: 200, name: 'company_name' })
  companyName!: string;

  @Column({ type: 'text', name: 'storage_key', nullable: true })
  storageKey!: string | null;

  @Column({ type: 'bigint', name: 'size_bytes', default: '0' })
  sizeBytes!: string;

  @Column({ type: 'timestamptz', name: 'expires_at' })
  expiresAt!: Date;

  /** Set when the file was removed (expired); the row stays as history. */
  @Column({ type: 'timestamptz', name: 'deleted_at', nullable: true })
  deletedAt!: Date | null;
}
