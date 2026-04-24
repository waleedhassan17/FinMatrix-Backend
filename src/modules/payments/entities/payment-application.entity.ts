import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Payment } from './payment.entity';

@Entity('payment_applications')
@Index(['paymentId'])
@Index(['invoiceId'])
export class PaymentApplication {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'payment_id' })
  paymentId!: string;

  @Column({ type: 'uuid', name: 'invoice_id' })
  invoiceId!: string;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'amount_applied',
  })
  amountApplied!: string;

  @ManyToOne(() => Payment, (p) => p.applications, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'payment_id' })
  payment!: Payment;
}
