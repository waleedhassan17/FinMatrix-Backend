import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('delivery_location_logs')
@Index(['deliveryId', 'createdAt'])
@Index(['personnelId', 'createdAt'])
export class DeliveryLocationLog {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'delivery_id' })
  deliveryId!: string;

  @Column({ type: 'uuid', name: 'personnel_id' })
  personnelId!: string;

  @Column({ type: 'float' })
  lat!: number;

  @Column({ type: 'float' })
  lng!: number;

  @Column({ type: 'float', nullable: true })
  heading!: number | null;

  @Column({ type: 'float', nullable: true })
  speed!: number | null;

  @Column({ type: 'float', nullable: true })
  accuracy!: number | null;

  @Column({ type: 'varchar', length: 20 })
  status!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt!: Date;
}
