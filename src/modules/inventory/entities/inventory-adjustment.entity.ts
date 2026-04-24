import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { InventoryAdjustmentReason } from '../../../types';

@Entity('inventory_adjustments')
@Index(['companyId', 'itemId'])
@Index(['companyId', 'date'])
export class InventoryAdjustment extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  @Column({ type: 'date' })
  date!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'previous_qty' })
  previousQty!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'new_qty' })
  newQty!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0 })
  variance!: string;

  @Column({ type: 'varchar', length: 32 })
  reason!: InventoryAdjustmentReason;

  @Column({ type: 'varchar', length: 64, nullable: true, name: 'reference_num' })
  referenceNum!: string | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'journal_entry_id' })
  journalEntryId!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;
}
