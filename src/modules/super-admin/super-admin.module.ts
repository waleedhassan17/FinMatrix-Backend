import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { SuperAdminController } from './super-admin.controller';
import { AdminCompaniesController } from './admin-companies.controller';
import { SuperAdminService } from './super-admin.service';
import { SubscriptionPlan } from './entities/subscription-plan.entity';
import { PlanOverride } from './entities/plan-override.entity';
import { PlanOverrideService } from './plan-override.service';
import { CompanySubscription } from './entities/company-subscription.entity';
import { Company } from '../companies/entities/company.entity';
import { UserCompany } from '../companies/entities/user-company.entity';
import { User } from '../users/entities/user.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      SubscriptionPlan,
      PlanOverride,
      CompanySubscription,
      Company,
      UserCompany,
      User,
    ]),
  ],
  controllers: [SuperAdminController, AdminCompaniesController],
  providers: [SuperAdminService, PlanOverrideService],
  // Exported so the plan overlay is loaded wherever this module is imported;
  // getPlanConfig() then serves edited prices to billing, auth, companies and
  // delivery-personnel without any of them knowing this service exists.
  exports: [SuperAdminService, PlanOverrideService],
})
export class SuperAdminModule {}
