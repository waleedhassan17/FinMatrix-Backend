import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { PurchaseOrderStatus } from '../../../types';
import { PurchaseOrderLine } from './purchase-order-line.entity';

@Entity('purchase_orders')
@Index(['companyId', 'poNumber'], { unique: true })
@Index(['companyId', 'status'])
@Index(['companyId', 'vendorId'])
export class PurchaseOrder extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'vendor_id' })
  vendorId!: string;

  @Column({ type: 'varchar', length: 32, name: 'po_number' })
  poNumber!: string;

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
  status!: PurchaseOrderStatus;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @OneToMany(() => PurchaseOrderLine, (l) => l.order, { cascade: true })
  lines!: PurchaseOrderLine[];
}
