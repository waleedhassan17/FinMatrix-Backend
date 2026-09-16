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

  /**
   * Set when the money was applied AFTER the receipt — an advance applied to
   * an invoice later, with its own date and its own Dr 2400 / Cr 1100 entry.
   * Both null means the application was part of the receipt's entry.
   */
  @Column({ type: 'date', nullable: true, name: 'applied_on' })
  appliedOn!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;

  @ManyToOne(() => Payment, (p) => p.applications, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'payment_id' })
  payment!: Payment;
}
