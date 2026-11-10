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
@Index('UQ_customers_company_code', ['companyId', 'code'], { unique: true })
export class Customer extends BaseCompanyEntity {
  /**
   * The customer's ID as people use it: C-0001 unless someone typed their own
   * (a Peachtree ID carried over, say). Stored upper-case, unique per company
   * (common/utils/party-code.util.ts). Every create path assigns one; NULL is
   * only possible for a row inserted outside TypeORM.
   */
  @Column({ type: 'varchar', length: 20, nullable: true })
  code!: string | null;

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

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'credit_limit',
  })
  creditLimit!: string;

  @Column({
    type: 'varchar',
    length: 32,
    default: 'net30',
    name: 'payment_terms',
  })
  paymentTerms!: PaymentTerms;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  balance!: string;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({
    type: 'varchar',
    length: 200,
    nullable: true,
    name: 'contact_person',
  })
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

  // ── FinMatrix Connect (1790500000000-MessagingFoundation) ──
  /** The number WhatsApp messages go to, E.164 ('+923001234567'). */
  @Column({
    type: 'varchar',
    length: 16,
    nullable: true,
    name: 'whatsapp_e164',
  })
  whatsappE164!: string | null;

  /** When someone recorded this contact's consent to WhatsApp messages. */
  @Column({ type: 'timestamptz', nullable: true, name: 'whatsapp_opt_in_at' })
  whatsappOptInAt!: Date | null;

  @Column({ type: 'uuid', nullable: true, name: 'whatsapp_opt_in_by' })
  whatsappOptInBy!: string | null;

  /** Set when the contact replies STOP / UNSUBSCRIBE. Nothing is sent after. */
  @Column({ type: 'boolean', default: false, name: 'whatsapp_opt_out' })
  whatsappOptOut!: boolean;

  /** Last time a message to this number was delivered. */
  @Column({ type: 'timestamptz', nullable: true, name: 'whatsapp_verified_at' })
  whatsappVerifiedAt!: Date | null;

  /**
   * WhatsApp's business-scoped user id (BSUID), learned from webhooks. A
   * contact with a WhatsApp username may reply with only this, no number.
   */
  @Column({
    type: 'varchar',
    length: 160,
    nullable: true,
    name: 'whatsapp_user_id',
    select: false,
  })
  whatsappUserId?: string | null;

  @Column({
    type: 'varchar',
    length: 2,
    nullable: true,
    name: 'preferred_language',
  })
  preferredLanguage!: 'en' | 'ur' | null;

  /** Stops payment reminders and statements for this customer only. */
  @Column({ type: 'boolean', default: false, name: 'collections_paused' })
  collectionsPaused!: boolean;
}
