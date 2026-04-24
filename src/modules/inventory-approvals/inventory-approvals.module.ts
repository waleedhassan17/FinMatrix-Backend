import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryUpdateRequest } from './entities/inventory-update-request.entity';
import { InventoryUpdateRequestLine } from './entities/inventory-update-request-line.entity';
import { InventoryApprovalsService } from './inventory-approvals.service';
import { InventoryApprovalsController } from './inventory-approvals.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([InventoryUpdateRequest, InventoryUpdateRequestLine]),
  ],
  providers: [InventoryApprovalsService],
  controllers: [InventoryApprovalsController],
  exports: [InventoryApprovalsService],
})
export class InventoryApprovalsModule {}
