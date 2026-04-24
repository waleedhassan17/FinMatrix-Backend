import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { PaymentTerms } from '../../../types';
import { Address } from '../../customers/entities/customer.entity';

@Entity('vendors')
@Index(['companyId', 'createdAt'])
@Index(['companyId', 'isActive'])
export class Vendor extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 200, name: 'company_name' })
  companyName!: string;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'contact_person' })
  contactPerson!: string | null;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'jsonb', nullable: true })
  address!: Address | null;

  @Column({ type: 'varchar', length: 32, default: 'net30', name: 'payment_terms' })
  paymentTerms!: PaymentTerms;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'tax_id' })
  taxId!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'default_expense_account_id' })
  defaultExpenseAccountId!: string | null;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  balance!: string;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;
}
