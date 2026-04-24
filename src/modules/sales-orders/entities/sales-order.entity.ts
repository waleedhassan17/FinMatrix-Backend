import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { SalesOrderStatus } from '../../../types';
import { SalesOrderLine } from './sales-order-line.entity';

@Entity('sales_orders')
@Index(['companyId', 'orderNumber'], { unique: true })
@Index(['companyId', 'status'])
@Index(['companyId', 'customerId'])
export class SalesOrder extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'customer_id' })
  customerId!: string;

  @Column({ type: 'varchar', length: 32, name: 'order_number' })
  orderNumber!: string;

  @Column({ type: 'date', name: 'order_date' })
  orderDate!: string;

  @Column({ type: 'date', nullable: true, name: 'expected_date' })
  expectedDate!: string | null;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  subtotal!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'tax_amount' })
  taxAmount!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  total!: string;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: SalesOrderStatus;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @OneToMany(() => SalesOrderLine, (l) => l.order, { cascade: true })
  lines!: SalesOrderLine[];
}
