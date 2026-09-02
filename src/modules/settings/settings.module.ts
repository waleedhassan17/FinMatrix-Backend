import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CompanySettings } from './entities/company-settings.entity';
import { SettingsService } from './settings.service';
import { CompanyUsersService } from './company-users.service';
import { SettingsController } from './settings.controller';
import { CompaniesModule } from '../companies/companies.module';
import { UsersModule } from '../users/users.module';

@Module({
  // OperationalAuditModule is @Global — no import needed for the audit service.
  imports: [TypeOrmModule.forFeature([CompanySettings]), CompaniesModule, UsersModule],
  providers: [SettingsService, CompanyUsersService],
  controllers: [SettingsController],
  exports: [SettingsService],
})
export class SettingsModule {}
