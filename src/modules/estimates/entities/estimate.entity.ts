import { Column, Entity, Index, OneToMany } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { EstimateLineItem } from './estimate-line-item.entity';

export type DiscountType = 'percent' | 'amount' | 'none';
export type EstimateStatus =
  | 'draft'
  | 'sent'
  | 'accepted'
  | 'declined'
  | 'converted'
  | 'expired';
export type ConvertedToType = 'invoice' | 'sales_order';

@Entity('estimates')
@Index(['companyId', 'estimateNumber'], { unique: true })
@Index(['companyId', 'status'])
@Index(['companyId', 'customerId'])
@Index(['companyId', 'createdAt'])
export class Estimate extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'customer_id' })
  customerId!: string;

  @Column({ type: 'varchar', length: 32, name: 'estimate_number' })
  estimateNumber!: string;

  @Column({ type: 'date', name: 'estimate_date' })
  estimateDate!: string;

  @Column({ type: 'date', name: 'expiry_date', nullable: true })
  expiryDate!: string | null;

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

  @Column({ type: 'varchar', length: 16, default: 'draft' })
  status!: EstimateStatus;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'varchar', length: 16, nullable: true, name: 'converted_to_type' })
  convertedToType!: ConvertedToType | null;

  @Column({ type: 'uuid', nullable: true, name: 'converted_to_id' })
  convertedToId!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;

  @OneToMany(() => EstimateLineItem, (li) => li.estimate, { cascade: true })
  lines!: EstimateLineItem[];
}
