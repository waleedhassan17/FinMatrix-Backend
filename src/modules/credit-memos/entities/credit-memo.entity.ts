import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { CreditMemoLine } from './credit-memo-line.entity';

@Entity('credit_memos')
@Index(['companyId', 'customerId'])
@Index(['companyId', 'createdAt'])
export class CreditMemo extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'customer_id' })
  customerId!: string;

  @Column({ type: 'date' })
  date!: string;

  @Column({ type: 'uuid', nullable: true, name: 'original_invoice_id' })
  originalInvoiceId!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  subtotal!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'tax_amount' })
  taxAmount!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  total!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'amount_applied' })
  amountApplied!: string;

  @Column({ type: 'varchar', length: 20, default: 'open' })
  status!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  balance!: string;

  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;

  @OneToMany(() => CreditMemoLine, (l) => l.creditMemo, { cascade: true })
  lines!: CreditMemoLine[];
}
