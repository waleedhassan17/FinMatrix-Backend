import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ApprovalRequest } from './entities/approval-request.entity';
import { ApprovalsService } from './approvals.service';
import { ApprovalDispatcher } from './approval-dispatcher.service';
import { ApprovalsController } from './approvals.controller';
import { InventoryModule } from '../inventory/inventory.module';
import { JournalEntriesModule } from '../journal-entries/journal-entries.module';
import { CreditMemosModule } from '../credit-memos/credit-memos.module';
import { VendorCreditsModule } from '../vendor-credits/vendor-credits.module';
import { BillsModule } from '../bills/bills.module';
import { PurchaseOrdersModule } from '../purchase-orders/purchase-orders.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { InventoryApprovalsModule } from '../inventory-approvals/inventory-approvals.module';

/**
 * Maker-checker for the actions staff may request but not perform.
 *
 * The module owns the request row and the dispatcher; it owns no posting logic
 * whatsoever. Every gated action is replayed against the service that already
 * implements it, so an approved request and an owner's direct action go
 * through exactly the same code and produce exactly the same accounting.
 *
 * ApprovalsService is exported because the gate lives in the OWNING
 * controllers — inventory, bills, purchase orders and so on each decide
 * between "post now" and "file a request" — never inside a service, so that
 * service-to-service posting (delivery dispatch, reject-time credit memos)
 * stays untouched.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ApprovalRequest]),
    InventoryModule,
    JournalEntriesModule,
    CreditMemosModule,
    VendorCreditsModule,
    BillsModule,
    PurchaseOrdersModule,
    InvoicesModule,
    InventoryApprovalsModule,
  ],
  controllers: [ApprovalsController],
  providers: [ApprovalsService, ApprovalDispatcher],
  exports: [ApprovalsService],
})
export class ApprovalsModule {}
