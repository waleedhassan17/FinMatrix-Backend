import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Company } from './entities/company.entity';
import { UserCompany } from './entities/user-company.entity';
import { Account } from '../accounts/entities/account.entity';
import { SubscriptionPlan } from '../super-admin/entities/subscription-plan.entity';
import { CompanySubscription } from '../super-admin/entities/company-subscription.entity';
import { UsersModule } from '../users/users.module';
import { BillingModule } from '../billing/billing.module';
import { PaymentSubmission } from '../billing/entities/payment-submission.entity';
import { TrialClaim } from '../billing/entities/trial-claim.entity';
import { CompaniesService } from './companies.service';
import { CompaniesController } from './companies.controller';

@Module({
  imports: [
    UsersModule,
    TypeOrmModule.forFeature([Company, UserCompany, Account, SubscriptionPlan, CompanySubscription]),
    // The free-trial request files into billing's review queue and answers
    // with billing's status shape. BillingModule imports nothing from
    // companies, so the dependency is one-way — no forwardRef.
    BillingModule,
    TypeOrmModule.forFeature([PaymentSubmission, TrialClaim]),
  ],
  controllers: [CompaniesController],
  providers: [CompaniesService],
  exports: [CompaniesService, TypeOrmModule],
})
export class CompaniesModule {}
