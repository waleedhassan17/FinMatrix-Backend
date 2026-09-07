import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Payment } from './entities/payment.entity';
import { PaymentApplication } from './entities/payment-application.entity';
import { Customer } from '../customers/entities/customer.entity';
import { PaymentsService } from './payments.service';
import { PaymentsController } from './payments.controller';
import { JournalEntriesModule } from '../journal-entries/journal-entries.module';
import { AccountsModule } from '../accounts/accounts.module';
import { InvoicesModule } from '../invoices/invoices.module';
import { ApprovalsCoreModule } from '../approvals/approvals-core.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, PaymentApplication, Customer]),
    JournalEntriesModule,
    AccountsModule,
    InvoicesModule,
    // The gate for receiving a payment lives in this controller. Core, not
    // ApprovalsModule: that one imports every domain module, and importing it
    // back would be the cycle ApprovalsCoreModule exists to avoid.
    ApprovalsCoreModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
