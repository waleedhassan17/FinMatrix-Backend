import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { PaymentTerms } from '../../../types';

export interface Address {
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
}

@Entity('customers')
@Index(['companyId', 'createdAt'])
@Index(['companyId', 'isActive'])
export class Customer extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  company!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'jsonb', nullable: true, name: 'billing_address' })
  billingAddress!: Address | null;

  @Column({ type: 'jsonb', nullable: true, name: 'shipping_address' })
  shippingAddress!: Address | null;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'credit_limit' })
  creditLimit!: string;

  @Column({ type: 'varchar', length: 32, default: 'net30', name: 'payment_terms' })
  paymentTerms!: PaymentTerms;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  balance!: string;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;
}
