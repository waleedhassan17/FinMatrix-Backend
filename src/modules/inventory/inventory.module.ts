import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryItem } from './entities/inventory-item.entity';
import { InventoryMovement } from './entities/inventory-movement.entity';
import { InventoryAdjustment } from './entities/inventory-adjustment.entity';
import { InventoryLocation } from './entities/inventory-location.entity';
import { StockTransfer } from './entities/stock-transfer.entity';
import { StockTransferLine } from './entities/stock-transfer-line.entity';
import { PhysicalCount } from './entities/physical-count.entity';
import { PhysicalCountLine } from './entities/physical-count-line.entity';
import { InventoryService } from './inventory.service';
import { InventoryController } from './inventory.controller';
import { InventoryItemImage } from './images/inventory-item-image.entity';
import { InventoryImagesService } from './images/inventory-images.service';
import { ItemImageUrlsInterceptor } from './images/item-image-urls.interceptor';
import { ItemMediaController } from './images/item-media.controller';
import { MediaUrlSigner } from './images/media-url.signer';
import { InventoryImportService } from './import/inventory-import.service';
import { InventoryImportController } from './import/inventory-import.controller';
import { AccountsModule } from '../accounts/accounts.module';
import { JournalEntriesModule } from '../journal-entries/journal-entries.module';
import { ApprovalsCoreModule } from '../approvals/approvals-core.module';

@Module({
  // ApprovalsCoreModule (not ApprovalsModule) so no cycle: the gate only
  // needs to FILE a request, which touches no domain service.
  imports: [
    ApprovalsCoreModule,
    TypeOrmModule.forFeature([
      InventoryItem,
      InventoryMovement,
      InventoryAdjustment,
      InventoryLocation,
      StockTransfer,
      StockTransferLine,
      PhysicalCount,
      PhysicalCountLine,
      InventoryItemImage,
    ]),
    AccountsModule,
    JournalEntriesModule,
  ],
  providers: [
    InventoryService,
    MediaUrlSigner,
    InventoryImagesService,
    ItemImageUrlsInterceptor,
    InventoryImportService,
  ],
  controllers: [InventoryController, InventoryImportController, ItemMediaController],
  exports: [InventoryService, MediaUrlSigner],
})
export class InventoryModule {}
