import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { PaymentMethod } from '../../../types';
import { PaymentApplication } from './payment-application.entity';

@Entity('payments')
@Index(['companyId', 'customerId'])
@Index(['companyId', 'createdAt'])
@Index('UQ_payments_company_payment_number', ['companyId', 'paymentNumber'], { unique: true })
export class Payment extends BaseCompanyEntity {
  /** RCT-YYYY-NNNN, from the RCT document series. Null only if never backfilled. */
  @Column({ type: 'varchar', length: 32, nullable: true, name: 'payment_number' })
  paymentNumber!: string | null;

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

  /**
   * Where the unapplied part of this receipt sits in the ledger.
   *
   * true  — credited to 2400 Customer Advances (every receipt from now on), so
   *         applying it later posts Dr 2400 / Cr 1100.
   * false — a receipt recorded before advances existed: the whole amount was
   *         credited to 1100, so its remainder is already a credit inside
   *         Accounts Receivable and applying it posts nothing.
   */
  @Column({ type: 'boolean', default: false, name: 'advance_posted' })
  advancePosted!: boolean;

  @OneToMany(() => PaymentApplication, (pa) => pa.payment, { cascade: true })
  applications!: PaymentApplication[];
}
