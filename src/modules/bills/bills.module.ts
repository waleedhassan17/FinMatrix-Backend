import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Bill } from './entities/bill.entity';
import { BillLineItem } from './entities/bill-line-item.entity';
import { BillPayment } from './entities/bill-payment.entity';
import { BillPaymentApplication } from './entities/bill-payment-application.entity';
import { BillPaymentProof } from './entities/bill-payment-proof.entity';
import { Vendor } from '../vendors/entities/vendor.entity';
import { BillsService } from './bills.service';
import { BillsController } from './bills.controller';
import { BillPaymentsController } from './bill-payments.controller';
import { JournalEntriesModule } from '../journal-entries/journal-entries.module';
import { AccountsModule } from '../accounts/accounts.module';
import { ApprovalsCoreModule } from '../approvals/approvals-core.module';

@Module({
  imports: [
    ApprovalsCoreModule,
    TypeOrmModule.forFeature([
      Bill,
      BillLineItem,
      BillPayment,
      BillPaymentApplication,
      BillPaymentProof,
      Vendor,
    ]),
    JournalEntriesModule,
    AccountsModule,
  ],
  controllers: [BillsController, BillPaymentsController],
  providers: [BillsService],
  exports: [BillsService, TypeOrmModule],
})
export class BillsModule {}
