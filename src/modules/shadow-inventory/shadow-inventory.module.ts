import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ShadowInventorySnapshot } from './entities/shadow-inventory-snapshot.entity';
import { ShadowInventoryService } from './shadow-inventory.service';
import { ShadowInventoryController } from './shadow-inventory.controller';

@Module({
  imports: [TypeOrmModule.forFeature([ShadowInventorySnapshot])],
  providers: [ShadowInventoryService],
  controllers: [ShadowInventoryController],
  exports: [ShadowInventoryService],
})
export class ShadowInventoryModule {}
