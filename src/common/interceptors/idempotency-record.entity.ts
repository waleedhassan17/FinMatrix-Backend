import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Stores the outcome of an idempotent POST so a retried request (same
 * Idempotency-Key header, same company) returns the original response instead
 * of posting twice (FinMatrixGuide §6.3). Critical on mobile networks.
 */
@Entity('idempotency_records')
@Index(['companyId', 'idempotencyKey'], { unique: true })
export class IdempotencyRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'varchar', length: 200, name: 'idempotency_key' })
  idempotencyKey!: string;

  @Column({ type: 'varchar', length: 8 })
  method!: string;

  @Column({ type: 'varchar', length: 300 })
  path!: string;

  // 'pending' while in flight, 'completed' once the response is captured.
  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: string;

  @Column({ type: 'int', nullable: true, name: 'status_code' })
  statusCode!: number | null;

  @Column({ type: 'jsonb', nullable: true, name: 'response_body' })
  responseBody!: unknown;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
