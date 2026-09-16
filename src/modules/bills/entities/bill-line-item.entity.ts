import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Bill } from './bill.entity';

@Entity('bill_line_items')
@Index(['billId'])
export class BillLineItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'bill_id' })
  billId!: string;

  @Column({ type: 'uuid', name: 'account_id' })
  accountId!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  amount!: string;

  @Column({ type: 'decimal', precision: 8, scale: 4, default: 0, name: 'tax_rate' })
  taxRate!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'tax_amount' })
  taxAmount!: string;

  @Column({ type: 'int', default: 0, name: 'line_order' })
  lineOrder!: number;

  /** The purchase order line this bill line billed, when raised from a PO. */
  @Column({ type: 'uuid', nullable: true, name: 'purchase_order_line_id' })
  purchaseOrderLineId!: string | null;

  /** Quantity of that PO line this bill line covers. */
  @Column({ type: 'decimal', precision: 18, scale: 4, nullable: true })
  quantity!: string | null;

  /**
   * GRNI this line clears (Dr 2050). Any difference to the line's cost is a
   * landed-cost variance posted to Inventory or COGS. Null for lines that do
   * not clear a receipt accrual.
   */
  @Column({ type: 'decimal', precision: 18, scale: 4, nullable: true, name: 'grni_amount' })
  grniAmount!: string | null;

  @ManyToOne(() => Bill, (b) => b.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bill_id' })
  bill!: Bill;
}
