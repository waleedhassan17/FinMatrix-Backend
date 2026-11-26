import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Platform-level audit trail: what super-admins (and the system acting for
 * the platform) did — trial approvals, extensions, grants, suspensions,
 * deletions, demo pipeline changes.
 *
 * Deliberately NOT company-scoped: company_id is a plain nullable column with
 * no foreign key, and the company's name is copied in. A record of "who
 * deleted company X" must outlive company X; operational_audit_events is
 * company data and is purged with the company.
 */
@Entity('platform_audit_events')
@Index('idx_platform_audit_company', ['companyId', 'createdAt'])
@Index('idx_platform_audit_action', ['action', 'createdAt'])
@Index('idx_platform_audit_target', ['targetType', 'targetId'])
export class PlatformAuditEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The super-admin who acted; null when the system acted (see actorLabel). */
  @Column({ type: 'uuid', name: 'actor_user_id', nullable: true })
  actorUserId!: string | null;

  /** e.g. the admin's email, or 'system:auto' for an automatic approval. */
  @Column({ type: 'varchar', length: 255, name: 'actor_label', nullable: true })
  actorLabel!: string | null;

  @Column({ type: 'varchar', length: 64 })
  action!: string;

  @Column({ type: 'varchar', length: 64, name: 'target_type' })
  targetType!: string;

  @Column({ type: 'varchar', length: 64, name: 'target_id', nullable: true })
  targetId!: string | null;

  /** No FK on purpose: the record survives the company's deletion. */
  @Column({ type: 'uuid', name: 'company_id', nullable: true })
  companyId!: string | null;

  @Column({
    type: 'varchar',
    length: 200,
    name: 'company_name',
    nullable: true,
  })
  companyName!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  details!: Record<string, unknown> | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
