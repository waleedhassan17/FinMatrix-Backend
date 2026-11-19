import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReportsModule } from '../reports/reports.module';
import { CompanyExportService } from './company-export.service';
import { CompanyExportWorker } from './company-export.worker';
import { DataPortabilityController } from './data-portability.controller';
import { CompanyExport } from './entities/company-export.entity';
import { ExportDownloadController } from './export-download.controller';
import { ExportTokenSigner } from './export-token';
import { CompanyExportBuilder } from './exporter/company-export.builder';
import { ExportReportPdfs } from './exporter/report-pdfs';

/**
 * Company backup (FinMatrix Migration Center, Part B §1.1–1.2): an owner
 * downloads the whole company as one ZIP. StorageModule and the operational
 * audit are global; reports and notifications are imported.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([CompanyExport]),
    ConfigModule,
    ReportsModule,
    NotificationsModule,
  ],
  controllers: [DataPortabilityController, ExportDownloadController],
  providers: [
    CompanyExportService,
    CompanyExportWorker,
    CompanyExportBuilder,
    ExportReportPdfs,
    ExportTokenSigner,
  ],
  exports: [CompanyExportBuilder, CompanyExportService, ExportTokenSigner],
})
export class DataPortabilityModule {}
