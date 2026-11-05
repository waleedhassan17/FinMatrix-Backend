import { MessagingCoreModule } from '../messaging/messaging-core.module';
import { InvoiceDocumentRenderer } from './invoice-document.renderer';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Invoice } from './entities/invoice.entity';
import { InvoiceLineItem } from './entities/invoice-line-item.entity';
import { Customer } from '../customers/entities/customer.entity';
import { Company } from '../companies/entities/company.entity';
import { InvoicesService } from './invoices.service';
import { InvoicesController } from './invoices.controller';
import { InvoicePdfService } from './invoice-pdf.service';
import { JournalEntriesModule } from '../journal-entries/journal-entries.module';
import { AccountsModule } from '../accounts/accounts.module';
import { ApprovalsCoreModule } from '../approvals/approvals-core.module';

@Module({
  imports: [
    MessagingCoreModule,
    ApprovalsCoreModule,
    TypeOrmModule.forFeature([Invoice, InvoiceLineItem, Customer, Company]),
    JournalEntriesModule,
    AccountsModule,
  ],
  controllers: [InvoicesController],
  providers: [InvoicesService, InvoicePdfService, InvoiceDocumentRenderer],
  exports: [InvoicesService, TypeOrmModule],
})
export class InvoicesModule {}
