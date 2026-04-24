import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';
import { InventoryCostMethod } from '../../../types';

@Entity('inventory_items')
@Index(['companyId', 'sku'], { unique: true })
@Index(['companyId', 'isActive'])
@Index(['companyId', 'sourceAgencyId'])
export class InventoryItem extends BaseCompanyEntity {
  @Column({ type: 'varchar', length: 64 })
  sku!: string;

  @Column({ type: 'varchar', length: 200 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  category!: string | null;

  @Column({ type: 'varchar', length: 32, default: 'unit', name: 'unit_of_measure' })
  unitOfMeasure!: string;

  @Column({ type: 'varchar', length: 16, default: 'average', name: 'cost_method' })
  costMethod!: InventoryCostMethod;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'unit_cost' })
  unitCost!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'selling_price' })
  sellingPrice!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'quantity_on_hand' })
  quantityOnHand!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'quantity_on_order' })
  quantityOnOrder!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'quantity_committed' })
  quantityCommitted!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'reorder_point' })
  reorderPoint!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'reorder_quantity' })
  reorderQuantity!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'min_stock' })
  minStock!: string;

  @Column({ type: 'decimal', precision: 18, scale: 4, default: 0, name: 'max_stock' })
  maxStock!: string;

  @Column({ type: 'uuid', nullable: true, name: 'source_agency_id' })
  sourceAgencyId!: string | null;

  @Column({ type: 'uuid', nullable: true, name: 'location_id' })
  locationId!: string | null;

  @Column({ type: 'boolean', default: false, name: 'serial_tracking' })
  serialTracking!: boolean;

  @Column({ type: 'boolean', default: false, name: 'lot_tracking' })
  lotTracking!: boolean;

  @Column({ type: 'varchar', length: 128, nullable: true, name: 'barcode_data' })
  barcodeData!: string | null;

  @Column({ type: 'boolean', default: true, name: 'is_active' })
  isActive!: boolean;
}
