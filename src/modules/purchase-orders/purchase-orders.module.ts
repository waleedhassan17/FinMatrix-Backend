import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PurchaseOrder } from './entities/purchase-order.entity';
import { PurchaseOrderLine } from './entities/purchase-order-line.entity';
import { PurchaseOrdersService } from './purchase-orders.service';
import { PurchaseOrdersController } from './purchase-orders.controller';
import { BillsModule } from '../bills/bills.module';
import { AccountsModule } from '../accounts/accounts.module';
import { JournalEntriesModule } from '../journal-entries/journal-entries.module';
import { ApprovalsCoreModule } from '../approvals/approvals-core.module';

@Module({
  imports: [
    ApprovalsCoreModule,
    TypeOrmModule.forFeature([PurchaseOrder, PurchaseOrderLine]),
    BillsModule,
    AccountsModule,
    JournalEntriesModule,
  ],
  controllers: [PurchaseOrdersController],
  providers: [PurchaseOrdersService],
  // Exported for the approvals dispatcher: a staff PO is committed only when
  // the owner approves it.
  exports: [PurchaseOrdersService],
})
export class PurchaseOrdersModule {}
