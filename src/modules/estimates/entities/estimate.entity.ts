import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { EstimateStatus } from '../../../types';
import { EstimateLineItem } from './estimate-line-item.entity';

@Entity('estimates')
@Index(['companyId', 'estimateNumber'], { unique: true })
@Index(['companyId', 'status'])
@Index(['companyId', 'customerId'])
export class Estimate extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'customer_id' })
  customerId!: string;

  @Column({ type: 'varchar', length: 32, name: 'estimate_number' })
  estimateNumber!: string;

  @Column({ type: 'date', name: 'estimate_date' })
  estimateDate!: string;

  @Column({ type: 'date', nullable: true, name: 'expiration_date' })
  expirationDate!: string | null;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  subtotal!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'discount_amount' })
  discountAmount!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'tax_amount' })
  taxAmount!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  total!: string;

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: EstimateStatus;

  @Column({ type: 'uuid', nullable: true, name: 'converted_to_invoice_id' })
  convertedToInvoiceId!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @OneToMany(() => EstimateLineItem, (l) => l.estimate, { cascade: true })
  lines!: EstimateLineItem[];
}
