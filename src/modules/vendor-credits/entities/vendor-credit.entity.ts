import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { VendorCreditLine } from './vendor-credit-line.entity';

@Entity('vendor_credits')
@Index(['companyId', 'vendorId'])
@Index(['companyId', 'createdAt'])
export class VendorCredit extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'vendor_id' })
  vendorId!: string;

  @Column({ type: 'date' })
  date!: string;

  @Column({ type: 'uuid', nullable: true, name: 'original_bill_id' })
  originalBillId!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  total!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'amount_applied' })
  amountApplied!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  balance!: string;

  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;

  @OneToMany(() => VendorCreditLine, (l) => l.vendorCredit, { cascade: true })
  lines!: VendorCreditLine[];
}
