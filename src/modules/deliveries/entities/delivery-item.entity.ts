import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Delivery } from './delivery.entity';

@Entity('delivery_items')
@Index(['deliveryId'])
export class DeliveryItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'delivery_id' })
  deliveryId!: string;

  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'ordered_qty' })
  orderedQty!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'delivered_qty' })
  deliveredQty!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'returned_qty' })
  returnedQty!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'unit_price' })
  unitPrice!: string;

  @ManyToOne(() => Delivery, (d) => d.items, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'delivery_id' })
  delivery!: Delivery;
}
