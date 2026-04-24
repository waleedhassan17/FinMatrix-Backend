import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { PurchaseOrder } from './purchase-order.entity';

@Entity('purchase_order_lines')
@Index(['orderId'])
export class PurchaseOrderLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'order_id' })
  orderId!: string;

  @Column({ type: 'uuid', nullable: true, name: 'item_id' })
  itemId!: string | null;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'ordered_qty' })
  orderedQty!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'received_qty' })
  receivedQty!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'unit_cost' })
  unitCost!: string;

  @Column({ type: 'decimal', precision: 8, scale: 4, default: 0, name: 'tax_rate' })
  taxRate!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'line_total' })
  lineTotal!: string;

  @Column({ type: 'uuid', nullable: true, name: 'account_id' })
  accountId!: string | null;

  @Column({ type: 'int', default: 0, name: 'line_order' })
  lineOrder!: number;

  @ManyToOne(() => PurchaseOrder, (o) => o.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'order_id' })
  order!: PurchaseOrder;
}
