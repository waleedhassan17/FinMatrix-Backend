import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { DeliveryPersonnelStatus } from '../../../types';

@Entity('delivery_personnel_profiles')
@Index(['companyId', 'status'])
@Index(['companyId', 'isAvailable'])
export class DeliveryPersonnelProfile {
  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({ type: 'uuid', name: 'company_id' })
  companyId!: string;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'vehicle_type' })
  vehicleType!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'vehicle_number' })
  vehicleNumber!: string | null;

  @Column({ type: 'jsonb', default: () => "'[]'::jsonb" })
  zones!: string[];

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0, name: 'max_load' })
  maxLoad!: string;

  @Column({ type: 'decimal', precision: 10, scale: 2, default: 0, name: 'current_load' })
  currentLoad!: string;

  @Column({ type: 'boolean', default: true, name: 'is_available' })
  isAvailable!: boolean;

  @Column({ type: 'varchar', length: 16, default: 'active' })
  status!: DeliveryPersonnelStatus;

  @Column({ type: 'decimal', precision: 3, scale: 2, default: 5.0 })
  rating!: string;

  @Column({ type: 'int', default: 0, name: 'total_deliveries' })
  totalDeliveries!: number;

  @Column({ type: 'decimal', precision: 5, scale: 2, default: 100, name: 'on_time_rate' })
  onTimeRate!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  updatedAt!: Date;
}
