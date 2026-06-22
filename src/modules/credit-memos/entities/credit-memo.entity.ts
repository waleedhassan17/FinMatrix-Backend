import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { CreditMemoLine } from './credit-memo-line.entity';

export type CreditMemoStatus = 'open' | 'applied' | 'closed' | 'refunded' | 'void';

@Entity('credit_memos')
@Index(['companyId', 'status'])
@Index(['companyId', 'customerId'])
export class CreditMemo extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'customer_id' })
  customerId!: string;

  @Column({ type: 'varchar', length: 32, name: 'credit_memo_number', nullable: true })
  creditMemoNumber!: string | null;

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

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  balance!: string;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: CreditMemoStatus;

  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;

  @Column({ type: 'uuid', name: 'created_by', nullable: true })
  createdBy!: string | null;

  @OneToMany(() => CreditMemoLine, (l) => l.creditMemo, { cascade: true })
  lines!: CreditMemoLine[];
}
