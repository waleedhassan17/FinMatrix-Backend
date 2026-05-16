import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { ShadowSyncStatus } from '../../../types';

@Entity('shadow_inventory_snapshots')
@Index(['companyId', 'personnelId', 'itemId'], { unique: true })
export class ShadowInventorySnapshot extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'personnel_id' })
  personnelId!: string;

  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  @Column({ type: 'varchar', length: 200, nullable: true, name: 'item_name' })
  itemName!: string | null;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'original_qty' })
  originalQty!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'current_qty' })
  currentQty!: string;

  @Column({ type: 'timestamptz', nullable: true, name: 'last_sync_at' })
  lastSyncAt!: Date | null;

  @Column({ type: 'varchar', length: 16, default: 'synced', name: 'sync_status' })
  syncStatus!: ShadowSyncStatus;
}
