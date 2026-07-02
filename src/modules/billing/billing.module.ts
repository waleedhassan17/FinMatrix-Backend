import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from '../companies/entities/company.entity';
import { UserCompany } from '../companies/entities/user-company.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentSubmission } from './entities/payment-submission.entity';
import { PlatformRevenue } from './entities/platform-revenue.entity';
import { BillingService } from './billing.service';
import { BillingCronService } from './billing-cron.service';
import { BillingController } from './billing.controller';
import { BillingAdminController } from './billing-admin.controller';

/**
 * phase2.md — subscription lifecycle: one reusable manual bank-transfer flow
 * (bill → screenshot → super-admin approval) across signup / renewal / upgrade,
 * plan-based delivery-personnel limits, and a daily expiry/reminder cron.
 * StorageService is global. NotificationsService is imported for reminders.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      PaymentSubmission,
      PlatformRevenue,
      Company,
      UserCompany,
    ]),
    NotificationsModule,
  ],
  controllers: [BillingController, BillingAdminController],
  providers: [BillingService, BillingCronService],
  exports: [BillingService],
})
export class BillingModule {}
