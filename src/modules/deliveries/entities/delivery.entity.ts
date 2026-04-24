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

  @OneToMany(() => DeliveryItem, (i) => i.delivery, { cascade: true })
  items!: DeliveryItem[];
}
