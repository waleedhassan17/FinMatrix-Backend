import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from '../companies/entities/company.entity';
import { UserCompany } from '../companies/entities/user-company.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { PaymentSubmission } from './entities/payment-submission.entity';
import { PlatformRevenue } from './entities/platform-revenue.entity';
import { TrialClaim } from './entities/trial-claim.entity';
import { TrialAttempt } from './entities/trial-attempt.entity';
import { User } from '../users/entities/user.entity';
import { TrialService } from './trial/trial.service';
import { TrialAdminService } from './trial/trial-admin.service';
import { AdminTrialsController } from './trial/admin-trials.controller';
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
      TrialClaim,
      TrialAttempt,
      Company,
      UserCompany,
      User,
    ]),
    NotificationsModule,
  ],
  controllers: [
    BillingController,
    BillingAdminController,
    AdminTrialsController,
  ],
  providers: [
    BillingService,
    BillingCronService,
    TrialService,
    TrialAdminService,
  ],
  exports: [BillingService, TrialService, TrialAdminService],
})
export class BillingModule {}
