import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export type InventoryApprovalAction = 'approved' | 'rejected';

/**
 * Lightweight audit row for inventory-update-request reviews.
 * Complements the global `audit_trail` table with a domain-specific shape.
 */
@Entity('inventory_approval_audit_entries')
@Index(['requestId', 'createdAt'])
@Index(['companyId', 'createdAt'])
export class InventoryApprovalAuditEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'uuid', name: 'request_id' })
  requestId!: string;

  @Column({ type: 'varchar', length: 16 })
  action!: InventoryApprovalAction;

  @Column({ type: 'uuid', name: 'reviewed_by' })
  reviewedBy!: string;

  @Column({ type: 'text', nullable: true })
  details!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
