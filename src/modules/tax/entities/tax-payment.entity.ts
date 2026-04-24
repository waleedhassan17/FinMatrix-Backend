import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

@Entity('tax_payments')
@Index(['companyId', 'paymentDate'])
export class TaxPayment extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'tax_rate_id' })
  taxRateId!: string;

  @Column({ type: 'varchar', length: 32 })
  period!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  amount!: string;

  @Column({ type: 'date', name: 'payment_date' })
  paymentDate!: string;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reference!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;
}
