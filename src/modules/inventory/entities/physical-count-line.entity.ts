import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PhysicalCount } from './physical-count.entity';

@Entity('physical_count_lines')
@Index(['countId'])
export class PhysicalCountLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'count_id' })
  countId!: string;

  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'system_qty' })
  systemQty!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'counted_qty' })
  countedQty!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  variance!: string;

  @Column({ type: 'uuid', nullable: true, name: 'adjustment_id' })
  adjustmentId!: string | null;

  @ManyToOne(() => PhysicalCount, (c) => c.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'count_id' })
  count!: PhysicalCount;
}
