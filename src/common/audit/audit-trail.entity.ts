import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type AuditAction = 'create' | 'update' | 'void' | 'delete';

/**
 * Financial audit trail: who changed which document, when, and what it looked
 * like before and after.
 *
 * The table has existed since InitialSchema but nothing ever wrote to it and
 * it was never mapped as an entity, so `auditLog` was an advertised tier
 * feature backed by zero rows (audit gap G2). Rows are written by
 * FinancialAuditSubscriber after the transaction commits.
 *
 * Distinct from OperationalAuditEvent, which covers non-financial admin
 * actions (rider resets, reconciliation undo) and has no before/after.
 */
@Entity('audit_trail')
@Index(['companyId', 'createdAt'])
@Index(['companyId', 'module', 'action'])
@Index(['companyId', 'userId'])
export class AuditTrailEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  /** Null for system actors: scheduled jobs, queue workers, seeds. */
  @Column({ type: 'uuid', name: 'user_id', nullable: true })
  userId!: string | null;

  @Column({ type: 'varchar', length: 64 })
  action!: AuditAction;

  @Column({ type: 'varchar', length: 64 })
  module!: string;

  @Column({ type: 'varchar', length: 64, name: 'resource_type' })
  resourceType!: string;

  @Column({ type: 'uuid', name: 'resource_id', nullable: true })
  resourceId!: string | null;

  @Column({ type: 'jsonb', name: 'before_values', nullable: true })
  beforeValues!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', name: 'after_values', nullable: true })
  afterValues!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, name: 'ip_address', nullable: true })
  ipAddress!: string | null;

  @Column({ type: 'text', name: 'user_agent', nullable: true })
  userAgent!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
