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

  /**
   * The account this adjustment offset 1200 against, chosen by `reason`.
   *
   * Persisted rather than re-derived, for two reasons: a reversal has to
   * mirror the ORIGINAL entry exactly (re-deriving from today's map would
   * strand value in two accounts if the mapping ever changes), and rows
   * written before the map existed genuinely went to 6400 whatever their
   * reason says. Null only on rows the backfill missed; readers fall back to
   * ACCT_INVENTORY_ADJUSTMENT.
   */
  @Column({ type: 'varchar', length: 20, nullable: true, name: 'offset_account_number' })
  offsetAccountNumber!: string | null;

  @Column({ type: 'uuid', name: 'created_by' })
  createdBy!: string;
}
