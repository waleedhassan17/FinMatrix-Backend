import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { PaymentMethod } from '../../../types';
import { BillPaymentApplication } from './bill-payment-application.entity';

@Entity('bill_payments')
@Index(['companyId', 'vendorId'])
@Index(['companyId', 'createdAt'])
export class BillPayment extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'vendor_id' })
  vendorId!: string;

  @Column({ type: 'uuid', name: 'bank_account_id' })
  bankAccountId!: string;

  @Column({ type: 'date', name: 'payment_date' })
  paymentDate!: string;

  @Column({ type: 'varchar', length: 32, name: 'payment_method' })
  paymentMethod!: PaymentMethod;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reference!: string | null;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'total_amount' })
  totalAmount!: string;

  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;

  @OneToMany(() => BillPaymentApplication, (a) => a.billPayment, { cascade: true })
  applications!: BillPaymentApplication[];
}
