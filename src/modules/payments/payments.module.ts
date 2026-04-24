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

@Module({
  imports: [
    TypeOrmModule.forFeature([Payment, PaymentApplication, Customer]),
    JournalEntriesModule,
    AccountsModule,
    InvoicesModule,
  ],
  controllers: [PaymentsController],
  providers: [PaymentsService],
  exports: [PaymentsService],
})
export class PaymentsModule {}
