import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { VendorCredit } from './vendor-credit.entity';

@Entity('vendor_credit_lines')
@Index(['vendorCreditId'])
export class VendorCreditLine {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'vendor_credit_id' })
  vendorCreditId!: string;

  @Column({ type: 'uuid', name: 'account_id' })
  accountId!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  amount!: string;

  @Column({ type: 'int', default: 0, name: 'line_order' })
  lineOrder!: number;

  @ManyToOne(() => VendorCredit, (c) => c.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'vendor_credit_id' })
  vendorCredit!: VendorCredit;
}
