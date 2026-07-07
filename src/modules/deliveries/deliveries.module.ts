import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Delivery } from './entities/delivery.entity';
import { DeliveryItem } from './entities/delivery-item.entity';
import { DeliveryStatusHistory } from './entities/delivery-status-history.entity';
import { DeliverySignature } from './entities/delivery-signature.entity';
import { DeliveryIssue } from './entities/delivery-issue.entity';
import { DeliveryLocationLog } from './entities/delivery-location-log.entity';
import { DeliveryPersonnelProfile } from '../delivery-personnel/entities/delivery-personnel-profile.entity';
import { Customer } from '../customers/entities/customer.entity';
import { DeliveriesService } from './deliveries.service';
import { DeliveriesController } from './deliveries.controller';
import { GeocodingService } from './geocoding.service';
import { DeliveryLedgerService } from './delivery-ledger.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { JournalEntriesModule } from '../journal-entries/journal-entries.module';
import { AccountsModule } from '../accounts/accounts.module';
import { SalesOrdersModule } from '../sales-orders/sales-orders.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { PaymentsModule } from '../payments/payments.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Delivery,
      DeliveryItem,
      DeliveryStatusHistory,
      DeliverySignature,
      DeliveryIssue,
      DeliveryLocationLog,
      DeliveryPersonnelProfile,
      Customer,
    ]),
    NotificationsModule,
    // Ledger link (phase1.md): dispatch/approval postings reuse the shared
    // PostingService and the SO / Invoice / Payment services.
    JournalEntriesModule,
    AccountsModule,
    SalesOrdersModule,
    InvoicesModule,
    PaymentsModule,
  ],
  providers: [DeliveriesService, GeocodingService, DeliveryLedgerService],
  controllers: [DeliveriesController],
  exports: [DeliveriesService, DeliveryLedgerService],
})
export class DeliveriesModule {}
