import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { DeliveryPriority, DeliveryStatus } from '../../../types';
import { DeliveryItem } from './delivery-item.entity';

@Entity('deliveries')
@Index(['companyId', 'status'])
@Index(['companyId', 'personnelId'])
@Index(['companyId', 'customerId'])
@Index(['companyId', 'createdAt'])
export class Delivery extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'customer_id' })
  customerId!: string;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'customer_name' })
  customerName!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  zone!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true, name: 'reference_no' })
  referenceNo!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'personnel_id' })
  personnelId!: string | null;

  @Column({ type: 'varchar', length: 16, default: 'unassigned' })
  status!: DeliveryStatus;

  @Column({ type: 'varchar', length: 16, default: 'normal' })
  priority!: DeliveryPriority;

  @Column({ type: 'date', nullable: true, name: 'preferred_date' })
  preferredDate!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'preferred_time_slot' })
  preferredTimeSlot!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'assigned_at' })
  assignedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt!: Date | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'text', nullable: true, name: 'cancel_reason' })
  cancelReason!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  // -------- Bill-photo capture (replaces digital signature) --------
  @Column({ type: 'text', nullable: true, name: 'bill_photo_url' })
  billPhotoUrl!: string | null;

  @Column({ type: 'text', nullable: true, name: 'bill_photo_storage_key' })
  billPhotoStorageKey!: string | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'bill_photo_captured_at' })
  billPhotoCapturedAt!: Date | null;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'bill_signed_by' })
  billSignedBy!: string | null;

  @OneToMany(() => DeliveryItem, (i) => i.delivery, { cascade: true })
  items!: DeliveryItem[];
}
