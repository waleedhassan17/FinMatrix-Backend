import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Postgres-backed file storage — the fallback when Cloudinary is not
 * configured. Heroku's dyno filesystem is ephemeral, so files that must be
 * served later can never live on local disk (see phase3 Chunk 1 / the
 * payment-screenshot incident). Volume is small: proof-of-delivery photos,
 * ≤8 MB each.
 */
@Entity('stored_files')
@Index(['bucket', 'createdAt'])
export class StoredFileRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64 })
  bucket!: string;

  @Column({ type: 'varchar', length: 128, name: 'mime_type' })
  mimeType!: string;

  @Column({ type: 'varchar', length: 255, name: 'original_name' })
  originalName!: string;

  @Column({ type: 'integer' })
  size!: number;

  // select:false so list queries never drag megabytes of image data along;
  // loaded explicitly via addSelect when streaming.
  @Column({ type: 'bytea', select: false })
  data!: Buffer;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
