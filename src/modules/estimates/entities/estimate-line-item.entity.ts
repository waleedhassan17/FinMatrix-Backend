import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Estimate } from './estimate.entity';

@Entity('estimate_line_items')
@Index(['estimateId'])
export class EstimateLineItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'estimate_id' })
  estimateId!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 1 })
  quantity!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'unit_price' })
  unitPrice!: string;

  @Column({ type: 'decimal', precision: 8, scale: 4, default: 0, name: 'tax_rate' })
  taxRate!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'line_total' })
  lineTotal!: string;

  @Column({ type: 'int', default: 0, name: 'line_order' })
  lineOrder!: number;

  @ManyToOne(() => Estimate, (e) => e.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'estimate_id' })
  estimate!: Estimate;
}
