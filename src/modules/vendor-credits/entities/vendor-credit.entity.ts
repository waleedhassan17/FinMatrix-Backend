import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { VendorCreditLine } from './vendor-credit-line.entity';

export type VendorCreditStatus = 'open' | 'applied' | 'closed' | 'void';

@Entity('vendor_credits')
@Index(['companyId', 'status'])
@Index(['companyId', 'vendorId'])
export class VendorCredit extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'vendor_id' })
  vendorId!: string;

  @Column({ type: 'varchar', length: 32, name: 'vendor_credit_number', nullable: true })
  vendorCreditNumber!: string | null;

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

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: VendorCreditStatus;

  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;

  @Column({ type: 'uuid', name: 'created_by', nullable: true })
  createdBy!: string | null;

  @OneToMany(() => VendorCreditLine, (l) => l.vendorCredit, { cascade: true })
  lines!: VendorCreditLine[];
}
