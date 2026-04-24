import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { BillPayment } from './bill-payment.entity';

@Entity('bill_payment_applications')
@Index(['billPaymentId'])
@Index(['billId'])
export class BillPaymentApplication {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'bill_payment_id' })
  billPaymentId!: string;

  @Column({ type: 'uuid', name: 'bill_id' })
  billId!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  amount!: string;

  @ManyToOne(() => BillPayment, (bp) => bp.applications, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'bill_payment_id' })
  billPayment!: BillPayment;
}
