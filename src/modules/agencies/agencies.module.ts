import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Agency } from './entities/agency.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import { InventoryModule } from '../inventory/inventory.module';
import { AgenciesService } from './agencies.service';
import { AgenciesController } from './agencies.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([Agency, InventoryItem, InventoryMovement]),
    // An agency opening quantity is stock on the balance sheet, so it posts
    // Dr 1200 / Cr 3900 through the inventory module's shared helper.
    InventoryModule,
  ],
  providers: [AgenciesService],
  controllers: [AgenciesController],
  exports: [AgenciesService],
})
export class AgenciesModule {}
