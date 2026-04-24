import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { TaxType } from '../../../types';

@Entity('tax_rates')
@Index(['companyId', 'type'])
@Index(['companyId', 'isActive'])
export class TaxRate extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 120 })
  name!: string;

  @Column({ type: 'decimal', precision: 8, scale: 4, default: 0 })
  rate!: string;

  @Column({ type: 'varchar', length: 16 })
  type!: TaxType;

  @Column({ type: 'varchar', length: 120, nullable: true })
  authority!: string | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;

  @Column({ type: 'boolean', default: false, name: 'is_default' })
  isDefault!: boolean;
}
