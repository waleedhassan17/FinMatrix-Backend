import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn } from 'typeorm';
import { VendorCredit } from './vendor-credit.entity';

@Entity('vendor_credit_lines')
@Index(['vendorCreditId'])
export class VendorCreditLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'vendor_credit_id' })
  vendorCreditId!: string;

  @Column({ type: 'uuid', name: 'account_id', nullable: true })
  accountId!: string | null;

  /**
   * The stock that went back to the supplier. When set, the credit relieves
   * `quantity` from this item and posts its leg to Inventory 1200 instead of
   * an expense account — that is what makes `Dr A/P / Cr Inventory` true.
   * NULL for money-only credits (freight, price adjustment).
   */
  @Column({ type: 'uuid', name: 'item_id', nullable: true })
  itemId!: string | null;

  @Column({ type: 'decimal', precision: 18, scale: 4, nullable: true })
  quantity!: string | null;

  @Column({ type: 'text' })
  description!: string;

  /** Net amount, excluding tax. */
  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  amount!: string;

  /** Percent, e.g. '17.0000'. Drives the credit to Input Tax (1300). */
  @Column({ type: 'decimal', precision: 8, scale: 4, default: 0, name: 'tax_rate' })
  taxRate!: string;

  @Column({ type: 'int', default: 0, name: 'line_order' })
  lineOrder!: number;

  @ManyToOne(() => VendorCredit, (c) => c.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vendor_credit_id' })
  vendorCredit!: VendorCredit;
}
