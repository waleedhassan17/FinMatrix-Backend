import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { SalesOrderLineItem } from './sales-order-line-item.entity';

export type DiscountType = 'percent' | 'amount' | 'none';
export type SalesOrderStatus = 'open' | 'partial' | 'fulfilled' | 'invoiced' | 'cancelled';

@Entity('sales_orders')
@Index(['companyId', 'orderNumber'], { unique: true })
@Index(['companyId', 'status'])
@Index(['companyId', 'customerId'])
@Index(['companyId', 'createdAt'])
export class SalesOrder extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'customer_id' })
  customerId!: string;

  @Column({ type: 'varchar', length: 32, name: 'order_number' })
  orderNumber!: string;

  @Column({ type: 'date', name: 'order_date' })
  orderDate!: string;

  @Column({ type: 'date', name: 'expected_date', nullable: true })
  expectedDate!: string | null;

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

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: SalesOrderStatus;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'source_estimate_id' })
  sourceEstimateId!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'invoice_id' })
  invoiceId!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @OneToMany(() => SalesOrderLineItem, (li) => li.salesOrder, { cascade: true })
  lines!: SalesOrderLineItem[];
}
