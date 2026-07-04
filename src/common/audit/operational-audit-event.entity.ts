import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * Lightweight operational audit trail for non-financial admin actions
 * (rider password resets, deactivations, …). Financial documents already
 * carry their own audit context via journal entries; this covers the
 * operational surface phase3 requires to be "audited".
 */
@Entity('operational_audit_events')
@Index(['companyId', 'createdAt'])
@Index(['companyId', 'targetType', 'targetId'])
export class OperationalAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'uuid', name: 'actor_user_id', nullable: true })
  actorUserId!: string | null;

  @Column({ type: 'varchar', length: 64 })
  action!: string;

  @Column({ type: 'varchar', length: 64, name: 'target_type' })
  targetType!: string;

  @Column({ type: 'varchar', length: 64, name: 'target_id', nullable: true })
  targetId!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  details!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
