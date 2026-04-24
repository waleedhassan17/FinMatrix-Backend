import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { DeliveryStatus } from '../../../types';

@Entity('delivery_status_history')
@Index(['deliveryId', 'timestamp'])
export class DeliveryStatusHistory {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'delivery_id' })
  deliveryId!: string;

  @Column({ type: 'varchar', length: 16 })
  status!: DeliveryStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  timestamp!: Date;

  @Column({ type: 'jsonb', nullable: true })
  location!: { lat: number; lng: number } | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'uuid', name: 'changed_by' })
  changedBy!: string;
}
