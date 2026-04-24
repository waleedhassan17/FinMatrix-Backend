import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { InventoryMovementType } from '../../../types';

@Entity('inventory_movements')
@Index(['companyId', 'itemId', 'date'])
@Index(['companyId', 'date'])
export class InventoryMovement extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  @Column({ type: 'date' })
  date!: string;

  @Column({ type: 'varchar', length: 32 })
  type!: InventoryMovementType;

  @Column({ type: 'varchar', length: 64, nullable: true })
  reference!: string | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'quantity_change',
  })
  quantityChange!: string;

  @Column({
    type: 'decimal',
    precision: 18,
    scale: 4,
    default: 0,
    name: 'balance_after',
  })
  balanceAfter!: string;

  @Column({ type: 'varchar', length: 32, nullable: true, name: 'source_type' })
  sourceType!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'source_id' })
  sourceId!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'created_by' })
  createdBy!: string | null;
}
