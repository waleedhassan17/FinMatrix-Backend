import { Column, Entity, Index, OneToMany, VersionColumn } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { BillStatus } from '../../../types';
import { BillLineItem } from './bill-line-item.entity';

@Entity('bills')
@Index(['companyId', 'billNumber'])
@Index(['companyId', 'status'])
@Index(['companyId', 'vendorId'])
@Index(['companyId', 'createdAt'])
@Index('IDX_bills_purchase_order_id', ['purchaseOrderId'])
export class Bill extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'vendor_id' })
  vendorId!: string;

  @Column({ type: 'varchar', length: 64, name: 'bill_number' })
  billNumber!: string;

  @Column({ type: 'date', name: 'bill_date' })
  billDate!: string;

  @Column({ type: 'date', name: 'due_date' })
  dueDate!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  subtotal!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'tax_amount' })
  taxAmount!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  total!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'amount_paid' })
  amountPaid!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  balance!: string;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: BillStatus;

  @Column({ type: 'text', nullable: true })
  memo!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;

  // The PO this bill was created from, if any. No longer unique (QaFixesSchema):
  // a PO is billed once per receipt. Double-billing is prevented per line
  // instead — a bill covers received − billed quantity, and clears exactly the
  // GRNI still accrued on that line (purchase_order_lines.billed_qty /
  // grni_cleared), under a row lock on the PO.
  @Column({ type: 'uuid', nullable: true, name: 'purchase_order_id' })
  purchaseOrderId!: string | null;

  // Optimistic lock (FinMatrixGuide §6.7): prevents concurrent bill payments
  // from both reading the same balance and overpaying.
  @VersionColumn()
  version!: number;

  @OneToMany(() => BillLineItem, (l) => l.bill, { cascade: true })
  lines!: BillLineItem[];
}
