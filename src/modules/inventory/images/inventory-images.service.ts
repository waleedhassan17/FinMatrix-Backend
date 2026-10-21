import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not, Repository } from 'typeorm';
import { randomUUID } from 'crypto';
import { InventoryItem } from '../entities/inventory-item.entity';
import { InventoryItemImage } from './inventory-item-image.entity';
import {
  StorageService,
  ReadableStoredFile,
} from '../../../common/storage/storage.service';
import { OperationalAuditService } from '../../../common/audit/operational-audit.service';
import { processItemImage } from './item-image.processor';
import {
  ItemImageUrls,
  ItemImageVariant,
  MediaUrlSigner,
} from './media-url.signer';

export interface UploadedImageFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
  size: number;
}

const BUCKET = 'item-images';

/** `Sofa — front.HEIC` → `Sofa — front`, safe to store and to show. */
const baseName = (original: string): string => {
  const stem = (original || 'photo')
    .replace(/\.[^.]*$/, '')
    .replace(/[\\/"\r\n]/g, ' ')
    .trim();
  return (stem || 'photo').slice(0, 200);
};

@Injectable()
export class InventoryImagesService {
  private readonly logger = new Logger(InventoryImagesService.name);

  constructor(
    @InjectRepository(InventoryItem)
    private readonly itemRepo: Repository<InventoryItem>,
    @InjectRepository(InventoryItemImage)
    private readonly imageRepo: Repository<InventoryItemImage>,
    private readonly dataSource: DataSource,
    private readonly storage: StorageService,
    private readonly audit: OperationalAuditService,
    private readonly signer: MediaUrlSigner,
  ) {}

  /**
   * Give an item a photo, replacing any it had.
   *
   * The bytes are processed and stored BEFORE the transaction — sharp and the
   * Cloudinary round-trip take seconds, and holding the item's row lock across
   * them would stall every sale of that item. The transaction then only swaps
   * the pointer. If it fails, the freshly stored files are removed; if it
   * succeeds, the previous photo's files are. Either way nothing is orphaned
   * except on a crash between the two, which costs storage, never correctness.
   */
  async setImage(
    companyId: string,
    itemId: string,
    userId: string,
    file: UploadedImageFile,
  ): Promise<InventoryItem> {
    await this.findItem(companyId, itemId);

    const processed = await processItemImage(file.buffer);
    const imageId = randomUUID();
    const name = baseName(file.originalname);

    const display = await this.storage.putBuffer({
      bucket: BUCKET,
      buffer: processed.display.buffer,
      mimeType: 'image/jpeg',
      originalName: `${name}.jpg`,
      publicPath: `/media/item-images/${imageId}/display.jpg`,
    });
    let thumbKey: string;
    try {
      const thumb = await this.storage.putBuffer({
        bucket: BUCKET,
        buffer: processed.thumb.buffer,
        mimeType: 'image/jpeg',
        originalName: `${name}-thumb.jpg`,
        publicPath: `/media/item-images/${imageId}/thumb.jpg`,
      });
      thumbKey = thumb.key;
    } catch (err) {
      await this.storage.remove(display.key);
      throw err;
    }

    let result: { item: InventoryItem; previous: InventoryItemImage | null };
    try {
      result = await this.dataSource.transaction(async (em) => {
        const item = await this.lockItem(
          em.getRepository(InventoryItem),
          companyId,
          itemId,
        );
        const previous = item.imageId
          ? await em.findOne(InventoryItemImage, {
              where: { id: item.imageId, companyId },
            })
          : null;
        if (previous) await em.delete(InventoryItemImage, { id: previous.id });
        await em.insert(InventoryItemImage, {
          id: imageId,
          companyId,
          itemId,
          storageKey: display.key,
          thumbStorageKey: thumbKey,
          mimeType: 'image/jpeg',
          width: processed.display.width,
          height: processed.display.height,
          size: processed.display.size,
          thumbSize: processed.thumb.size,
          originalName: `${name}.jpg`,
          uploadedBy: userId,
        });
        item.imageId = imageId;
        return { item: await em.save(item), previous };
      });
    } catch (err) {
      await Promise.all([
        this.storage.remove(display.key),
        this.storage.remove(thumbKey),
      ]);
      throw err;
    }

    const { item: saved, previous } = result;
    if (previous) await this.removeFiles(previous);
    await this.audit.record({
      companyId,
      actorUserId: userId,
      action: previous
        ? 'inventory.item_photo_replaced'
        : 'inventory.item_photo_set',
      targetType: 'inventory_item',
      targetId: itemId,
      details: {
        imageId,
        originalName: file.originalname,
        uploadedBytes: file.size,
        storedBytes: processed.display.size + processed.thumb.size,
      },
    });
    return saved;
  }

  /** Take an item's photo away. A no-op when it has none. */
  async removeImage(
    companyId: string,
    itemId: string,
    userId: string,
  ): Promise<InventoryItem> {
    const { item: saved, removed } = await this.dataSource.transaction(
      async (em) => {
        const item = await this.lockItem(
          em.getRepository(InventoryItem),
          companyId,
          itemId,
        );
        if (!item.imageId) return { item, removed: null };
        const image = await em.findOne(InventoryItemImage, {
          where: { id: item.imageId, companyId },
        });
        if (image) await em.delete(InventoryItemImage, { id: image.id });
        item.imageId = null;
        return { item: await em.save(item), removed: image };
      },
    );

    if (removed) {
      await this.removeFiles(removed);
      await this.audit.record({
        companyId,
        actorUserId: userId,
        action: 'inventory.item_photo_removed',
        targetType: 'inventory_item',
        targetId: itemId,
        details: { imageId: removed.id },
      });
    }
    return saved;
  }

  /**
   * Photo URLs for a set of items, keyed by item id — for the quotation PDFs,
   * which hold document lines (with item ids) rather than items. Items with no
   * photo, or not in this company, are simply absent.
   */
  async imageUrlsFor(
    companyId: string,
    itemIds: string[],
  ): Promise<Record<string, ItemImageUrls>> {
    if (itemIds.length === 0) return {};
    const items = await this.itemRepo.find({
      where: { companyId, id: In(itemIds), imageId: Not(IsNull()) },
      select: { id: true, imageId: true },
    });
    const out: Record<string, ItemImageUrls> = {};
    for (const item of items) out[item.id] = this.signer.urlsFor(item.imageId);
    return out;
  }

  /**
   * The bytes behind a signed media URL. The caller has already verified the
   * signature, which is the whole authorisation: no company check here,
   * because the request carries no session to check it against.
   */
  async openVariant(
    imageId: string,
    variant: ItemImageVariant,
  ): Promise<ReadableStoredFile> {
    const row = await this.imageRepo.findOne({ where: { id: imageId } });
    const file = row
      ? await this.storage.read(
          variant === 'thumb' ? row.thumbStorageKey : row.storageKey,
        )
      : null;
    if (!file) {
      throw new NotFoundException({
        code: 'MEDIA_NOT_FOUND',
        message: 'This photo is no longer available.',
      });
    }
    return file;
  }

  private async findItem(
    companyId: string,
    itemId: string,
  ): Promise<InventoryItem> {
    const item = await this.itemRepo.findOne({
      where: { id: itemId, companyId },
    });
    if (!item) throw new NotFoundException('Inventory item not found');
    return item;
  }

  private async lockItem(
    repo: Repository<InventoryItem>,
    companyId: string,
    itemId: string,
  ): Promise<InventoryItem> {
    const item = await repo
      .createQueryBuilder('i')
      .setLock('pessimistic_write')
      .where('i.id = :id AND i.companyId = :cid', {
        id: itemId,
        cid: companyId,
      })
      .getOne();
    if (!item) throw new NotFoundException('Inventory item not found');
    return item;
  }

  private async removeFiles(image: InventoryItemImage): Promise<void> {
    await Promise.all([
      this.storage.remove(image.storageKey),
      this.storage.remove(image.thumbStorageKey),
    ]);
  }
}
