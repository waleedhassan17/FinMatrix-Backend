import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Bill } from './entities/bill.entity';
import { BillLineItem } from './entities/bill-line-item.entity';
import { BillPayment } from './entities/bill-payment.entity';
import { BillPaymentApplication } from './entities/bill-payment-application.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { BillsService } from './bills.service';
import { BillsController } from './bills.controller';
import { JournalEntriesModule } from '../journal-entries/journal-entries.module';
import { AccountsModule } from '../accounts/accounts.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Bill,
      BillLineItem,
      BillPayment,
      BillPaymentApplication,
      Vendor,
    ]),
    JournalEntriesModule,
    AccountsModule,
  ],
  controllers: [BillsController],
  providers: [BillsService],
  exports: [BillsService, TypeOrmModule],
})
export class BillsModule {}
