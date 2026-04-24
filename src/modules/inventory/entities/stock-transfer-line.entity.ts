import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { StockTransfer } from './stock-transfer.entity';

@Entity('stock_transfer_lines')
@Index(['transferId'])
export class StockTransferLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'transfer_id' })
  transferId!: string;

  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  quantity!: string;

  @ManyToOne(() => StockTransfer, (t) => t.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'transfer_id' })
  transfer!: StockTransfer;
}
