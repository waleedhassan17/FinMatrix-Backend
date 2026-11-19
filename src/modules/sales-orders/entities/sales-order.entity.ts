import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { SalesOrderLineItem } from './sales-order-line-item.entity';

export type DiscountType = 'percent' | 'amount' | 'none';
/**
 * open       nothing shipped or invoiced yet
 * partial    some goods shipped or invoiced, more to come
 * fulfilled  everything shipped, not all of it invoiced yet
 * invoiced   everything invoiced (goods billed ahead of delivery may still be
 *            awaiting shipment on orders converted before partial invoicing)
 * closed     short-closed by hand: the rest will not ship (reopenable)
 * cancelled  withdrawn before anything shipped or was invoiced
 *
 * Only closed and cancelled are set by hand; the rest follow from the lines
 * (see deriveSalesOrderStatus).
 */
export type SalesOrderStatus =
  | 'open'
  | 'partial'
  | 'fulfilled'
  | 'invoiced'
  | 'closed'
  | 'cancelled';

@Entity('sales_orders')
@Index(['companyId', 'orderNumber'], { unique: true })
@Index(['companyId', 'status'])
@Index(['companyId', 'customerId'])
@Index(['companyId', 'createdAt'])
@Index('IDX_sales_orders_company_order_date', ['companyId', 'orderDate'])
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

  @Column({
    type: 'varchar',
    length: 8,
    default: 'none',
    name: 'discount_type',
  })
  discountType!: DiscountType;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'discount_value',
  })
  discountValue!: string;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'discount_amount',
  })
  discountAmount!: string;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'tax_amount',
  })
  taxAmount!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  total!: string;

  @Column({ type: 'varchar', length: 16, default: 'open' })
  status!: SalesOrderStatus;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'source_estimate_id' })
  sourceEstimateId!: string | null;

  /** The latest live invoice raised from this order. An order can have several
   *  (one per shipment); invoices.sales_order_id lists them all. */
  @Column({ type: 'uuid', nullable: true, name: 'invoice_id' })
  invoiceId!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @OneToMany(() => SalesOrderLineItem, (li) => li.salesOrder, { cascade: true })
  lines!: SalesOrderLineItem[];
}
