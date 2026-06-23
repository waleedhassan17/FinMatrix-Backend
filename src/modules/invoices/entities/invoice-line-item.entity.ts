import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Invoice } from './invoice.entity';

@Entity('invoice_line_items')
@Index(['invoiceId'])
export class InvoiceLineItem {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', name: 'invoice_id' })
  invoiceId!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 1 })
  quantity!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'unit_price' })
  unitPrice!: string;

  @Column({ type: 'decimal', precision: 8, scale: 4, default: 0, name: 'tax_rate' })
  taxRate!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'tax_amount' })
  taxAmount!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'line_total' })
  lineTotal!: string;

  @Column({ type: 'uuid', nullable: true, name: 'account_id' })
  accountId!: string | null;

  // Optional link to an inventory item. When set, posting the invoice records a
  // COGS/Inventory cost entry and reduces quantity on hand (FinMatrixGuide §3.1).
  @Column({ type: 'uuid', nullable: true, name: 'item_id' })
  itemId!: string | null;

  @Column({ type: 'int', default: 0, name: 'line_order' })
  lineOrder!: number;

  @ManyToOne(() => Invoice, (i) => i.lines, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'invoice_id' })
  invoice!: Invoice;
}
