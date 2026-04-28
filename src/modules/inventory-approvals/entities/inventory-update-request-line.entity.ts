import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { InventoryUpdateRequest } from './inventory-update-request.entity';

@Entity('inventory_update_request_lines')
@Index(['requestId'])
export class InventoryUpdateRequestLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'request_id' })
  requestId!: string;

  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'item_name' })
  itemName!: string | null;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'before_qty' })
  beforeQty!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'delivered_qty' })
  deliveredQty!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'returned_qty' })
  returnedQty!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'after_qty' })
  afterQty!: string;

  @ManyToOne(() => InventoryUpdateRequest, (r) => r.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'request_id' })
  request!: InventoryUpdateRequest;
}
