import { Column, Entity } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

@Entity('inventory_locations')
export class InventoryLocation extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'jsonb', nullable: true })
  address!: Record<string, unknown> | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;
}
