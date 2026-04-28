import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { InventoryUpdateRequest } from './entities/inventory-update-request.entity';
import { InventoryUpdateRequestLine } from './entities/inventory-update-request-line.entity';
import { InventoryApprovalAuditEntry } from './entities/inventory-approval-audit-entry.entity';
import { Delivery } from '../deliveries/entities/delivery.entity';
import { User } from '../users/entities/user.entity';
import { UserCompany } from '../companies/entities/user-company.entity';
import { InventoryItem } from '../inventory/entities/inventory-item.entity';
import { InventoryMovement } from '../inventory/entities/inventory-movement.entity';
import { ShadowInventorySnapshot } from '../shadow-inventory/entities/shadow-inventory-snapshot.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { InventoryApprovalsService } from './inventory-approvals.service';
import { InventoryApprovalsController } from './inventory-approvals.controller';
import { BillPhotoController } from './bill-photo.controller';
import { InventoryUpdateRequestsController } from './inventory-update-requests.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      InventoryUpdateRequest,
      InventoryUpdateRequestLine,
      InventoryApprovalAuditEntry,
      Delivery,
      User,
      UserCompany,
      InventoryItem,
      InventoryMovement,
      ShadowInventorySnapshot,
    ]),
    NotificationsModule,
  ],
  providers: [InventoryApprovalsService],
  controllers: [
    InventoryApprovalsController,
    BillPhotoController,
    InventoryUpdateRequestsController,
  ],
  exports: [InventoryApprovalsService],
})
export class InventoryApprovalsModule {}
