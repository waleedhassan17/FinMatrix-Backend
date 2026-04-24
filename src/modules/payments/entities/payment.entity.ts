import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { PaymentMethod } from '../../../types';
import { PaymentApplication } from './payment-application.entity';

@Entity('payments')
@Index(['companyId', 'customerId'])
@Index(['companyId', 'createdAt'])
export class Payment extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'customer_id' })
  customerId!: string;

  @Column({ type: 'date', name: 'payment_date' })
  paymentDate!: string;

  @Column({ type: 'varchar', length: 32, name: 'payment_method' })
  paymentMethod!: PaymentMethod;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reference!: string | null;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  amount!: string;

  @Column({ type: 'uuid', name: 'bank_account_id' })
  bankAccountId!: string;

  @Column({ type: 'text', nullable: true })
  memo!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;

  @OneToMany(() => PaymentApplication, (pa) => pa.payment, { cascade: true })
  applications!: PaymentApplication[];
}
