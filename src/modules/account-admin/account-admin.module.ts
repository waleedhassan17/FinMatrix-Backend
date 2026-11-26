import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataPortabilityModule } from '../data-portability/data-portability.module';
import { SuperAdminModule } from '../super-admin/super-admin.module';
import { AccountAdminController } from './account-admin.controller';
import { AccountAdminService } from './account-admin.service';
import { AccountAdminWorker } from './account-admin.worker';
import { CompanyDeletion } from './entities/company-deletion.entity';
import { PlatformFinalBackup } from './entities/platform-final-backup.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([CompanyDeletion, PlatformFinalBackup]),
    // The final backup is the customer backup builder; suspension is
    // SuperAdminService's.
    DataPortabilityModule,
    SuperAdminModule,
  ],
  controllers: [AccountAdminController],
  providers: [AccountAdminService, AccountAdminWorker],
  exports: [AccountAdminService],
})
export class AccountAdminModule {}
