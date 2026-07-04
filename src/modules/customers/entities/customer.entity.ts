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

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'contact_person' })
  contactPerson!: string | null;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'tax_id' })
  taxId!: string | null;

  // Geocoded shipping address (used as delivery destination fallback).
  @Column({ type: 'double precision', nullable: true, name: 'shipping_lat' })
  shippingLat!: number | null;

  @Column({ type: 'double precision', nullable: true, name: 'shipping_lng' })
  shippingLng!: number | null;

  @Column({ type: 'timestamptz', nullable: true, name: 'shipping_geocoded_at' })
  shippingGeocodedAt!: Date | null;
}
