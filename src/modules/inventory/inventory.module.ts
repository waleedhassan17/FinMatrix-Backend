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

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InventoryItem,
      InventoryMovement,
      InventoryAdjustment,
      InventoryLocation,
      StockTransfer,
      StockTransferLine,
      PhysicalCount,
      PhysicalCountLine,
    ]),
  ],
  providers: [InventoryService],
  controllers: [InventoryController],
  exports: [InventoryService],
})
export class InventoryModule {}
