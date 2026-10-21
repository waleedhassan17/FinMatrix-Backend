import { Column, Entity, Index } from 'typeorm';
import { BaseCompanyEntity } from '../../../common/base/base-company.entity';

/**
 * The photo of an inventory item, stored as two normalised JPEGs.
 *
 * `storageKey` is the `display` rendition (long edge ≤ 1600 px) and
 * `thumbStorageKey` the `thumb` (≤ 480 px) — both StorageService keys
 * (`cld:…` or `db:…`). Neither is ever handed to a client: photos are served
 * by ItemMediaController through signed, expiring URLs built from this row's
 * id, so the storage backend can change without a single URL changing shape.
 *
 * A row is immutable. Replacing a photo inserts a new row and repoints
 * `inventory_items.image_id`, which is what lets the media route send
 * `Cache-Control: immutable`.
 */
@Entity('inventory_item_images')
@Index(['companyId', 'itemId'])
export class InventoryItemImage extends BaseCompanyEntity {
  @Column({ type: 'uuid', name: 'item_id' })
  itemId!: string;

  @Column({ type: 'varchar', length: 255, name: 'storage_key' })
  storageKey!: string;

  @Column({ type: 'varchar', length: 255, name: 'thumb_storage_key' })
  thumbStorageKey!: string;

  @Column({
    type: 'varchar',
    length: 64,
    name: 'mime_type',
    default: 'image/jpeg',
  })
  mimeType!: string;

  @Column({ type: 'integer' })
  width!: number;

  @Column({ type: 'integer' })
  height!: number;

  @Column({ type: 'integer' })
  size!: number;

  @Column({ type: 'integer', name: 'thumb_size' })
  thumbSize!: number;

  @Column({ type: 'varchar', length: 255, name: 'original_name' })
  originalName!: string;

  @Column({ type: 'uuid', name: 'uploaded_by' })
  uploadedBy!: string;
}
