import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('audit_trail')
@Index(['companyId', 'createdAt'])
@Index(['companyId', 'module', 'action'])
@Index(['companyId', 'userId'])
export class AuditTrail {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'uuid', nullable: true, name: 'user_id' })
  userId!: string | null;

  @Column({ type: 'varchar', length: 64 })
  action!: string;

  @Column({ type: 'varchar', length: 64 })
  module!: string;

  @Column({ type: 'varchar', length: 64, name: 'resource_type' })
  resourceType!: string;

  @Column({ type: 'uuid', nullable: true, name: 'resource_id' })
  resourceId!: string | null;

  @Column({ type: 'jsonb', nullable: true, name: 'before_values' })
  beforeValues!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', nullable: true, name: 'after_values' })
  afterValues!: Record<string, unknown> | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'ip_address' })
  ipAddress!: string | null;

  @Column({ type: 'text', nullable: true, name: 'user_agent' })
  userAgent!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
