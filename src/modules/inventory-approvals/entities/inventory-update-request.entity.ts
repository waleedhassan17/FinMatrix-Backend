import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { InventoryRequestStatus } from '../../../types';
import { InventoryUpdateRequestLine } from './inventory-update-request-line.entity';

@Entity('inventory_update_requests')
@Index(['companyId', 'status'])
@Index(['companyId', 'personnelId'])
@Index(['companyId', 'submittedAt'])
export class InventoryUpdateRequest extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'delivery_id' })
  deliveryId!: string;

  @Column({ type: 'uuid', name: 'personnel_id' })
  personnelId!: string;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status!: InventoryRequestStatus;

  @Column({ type: 'timestamptz', name: 'submitted_at' })
  submittedAt!: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'reviewed_at' })
  reviewedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'reviewed_by' })
  reviewedBy!: string | null;

  @Column({ type: 'text', nullable: true, name: 'approval_notes' })
  approvalNotes!: string | null;

  @Column({ type: 'text', nullable: true, name: 'reject_reason' })
  rejectReason!: string | null;

  @OneToMany(() => InventoryUpdateRequestLine, (l) => l.request, { cascade: true })
  lines!: InventoryUpdateRequestLine[];
}
