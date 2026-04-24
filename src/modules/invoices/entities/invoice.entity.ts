import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { InvoiceStatus, PaymentTerms } from '../../../types';
import { InvoiceLineItem } from './invoice-line-item.entity';

export type DiscountType = 'percent' | 'amount' | 'none';

@Entity('invoices')
@Index(['companyId', 'invoiceNumber'], { unique: true })
@Index(['companyId', 'status'])
@Index(['companyId', 'customerId'])
@Index(['companyId', 'createdAt'])
export class Invoice extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'customer_id' })
  customerId!: string;

  @Column({ type: 'varchar', length: 32, name: 'invoice_number' })
  invoiceNumber!: string;

  @Column({ type: 'date', name: 'invoice_date' })
  invoiceDate!: string;

  @Column({ type: 'date', name: 'due_date' })
  dueDate!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  subtotal!: string;

  @Column({ type: 'varchar', length: 8, default: 'none', name: 'discount_type' })
  discountType!: DiscountType;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'discount_value' })
  discountValue!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'discount_amount' })
  discountAmount!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'tax_amount' })
  taxAmount!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  total!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'amount_paid' })
  amountPaid!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  balance!: string;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: InvoiceStatus;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'varchar', length: 32, default: 'net30', name: 'payment_terms' })
  paymentTerms!: PaymentTerms;

  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @OneToMany(() => InvoiceLineItem, (li) => li.invoice, { cascade: true })
  lines!: InvoiceLineItem[];
}
