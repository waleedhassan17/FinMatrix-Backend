import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { LoggerModule } from 'nestjs-pino';

import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';
import mailConfig from './config/mail.config';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';
import { IdempotencyInterceptor } from './common/interceptors/idempotency.interceptor';
import { IdempotencyRecord } from './common/interceptors/idempotency-record.entity';
import { JwtAuthGuard } from './modules/auth/guards/jwt-auth.guard';

import { AppController } from './app.controller';
import { AppService } from './app.service';

import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { CompaniesModule } from './modules/companies/companies.module';
import { AccountsModule } from './modules/accounts/accounts.module';
import { LedgerModule } from './modules/ledger/ledger.module';
import { JournalEntriesModule } from './modules/journal-entries/journal-entries.module';
import { CustomersModule } from './modules/customers/customers.module';
import { InvoicesModule } from './modules/invoices/invoices.module';
import { EstimatesModule } from './modules/estimates/estimates.module';
import { SalesOrdersModule } from './modules/sales-orders/sales-orders.module';
import { CreditMemosModule } from './modules/credit-memos/credit-memos.module';
import { VendorCreditsModule } from './modules/vendor-credits/vendor-credits.module';
import { BudgetsModule } from './modules/budgets/budgets.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { PaymentsModule } from './modules/payments/payments.module';
import { VendorsModule } from './modules/vendors/vendors.module';
import { BillsModule } from './modules/bills/bills.module';
import { PurchaseOrdersModule } from './modules/purchase-orders/purchase-orders.module';

// Module 2
import { AgenciesModule } from './modules/agencies/agencies.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { DeliveryPersonnelModule } from './modules/delivery-personnel/delivery-personnel.module';
import { DeliveriesModule } from './modules/deliveries/deliveries.module';
import { InventoryApprovalsModule } from './modules/inventory-approvals/inventory-approvals.module';
import { ShadowInventoryModule } from './modules/shadow-inventory/shadow-inventory.module';
import { TaxModule } from './modules/tax/tax.module';
import { ReconciliationsModule } from './modules/reconciliations/reconciliations.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { SettingsModule } from './modules/settings/settings.module';
import { ReportsModule } from './modules/reports/reports.module';
import { SearchModule } from './modules/search/search.module';
import { HealthModule } from './modules/health/health.module';
import { SuperAdminModule } from './modules/super-admin/super-admin.module';
import { BillingModule } from './modules/billing/billing.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { envValidationSchema } from './config/env.validation';
import { StorageModule } from './common/storage/storage.module';
import { MailModule } from './modules/mail/mail.module';
import { OperationalAuditModule } from './common/audit/operational-audit.module';
import { SentryModule } from '@sentry/nestjs/setup';

@Module({
  imports: [
    // Sentry first so its error hooks wrap everything that follows.
    SentryModule.forRoot(),
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, jwtConfig, mailConfig],
      envFilePath: ['.env'],
      cache: true,
      validationSchema: envValidationSchema,
      validationOptions: { abortEarly: false, allowUnknown: true },
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService): TypeOrmModuleOptions =>
        config.getOrThrow<TypeOrmModuleOptions>('database'),
    }),
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => [
        {
          ttl: config.get<number>('app.throttleTtlSeconds', 60) * 1000,
          limit: config.get<number>('app.throttleLimit', 100),
        },
      ],
    }),
    MailModule,
    OperationalAuditModule,
    UsersModule,
    TypeOrmModule.forFeature([IdempotencyRecord]),
    AuthModule,
    CompaniesModule,
    AccountsModule,
    LedgerModule,
    JournalEntriesModule,
    CustomersModule,
    InvoicesModule,
    SalesOrdersModule,
    EstimatesModule,
    CreditMemosModule,
    VendorCreditsModule,
    BudgetsModule,
    PayrollModule,
    PaymentsModule,
    VendorsModule,
    BillsModule,
    PurchaseOrdersModule,
    AgenciesModule,
    InventoryModule,
    DeliveryPersonnelModule,
    DeliveriesModule,
    InventoryApprovalsModule,
    ShadowInventoryModule,
    TaxModule,
    ReconciliationsModule,
    NotificationsModule,
    SettingsModule,
    ReportsModule,
    SearchModule,
    HealthModule,
    StorageModule,
    SuperAdminModule,
    BillingModule,
    ScheduleModule.forRoot(),
    LoggerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        pinoHttp: {
          level: config.get<string>('app.logLevel', 'info'),
          transport:
            config.get<string>('app.nodeEnv') !== 'production'
              ? {
                  target: 'pino-pretty',
                  options: {
                    singleLine: true,
                    translateTime: 'SYS:standard',
                    ignore: 'pid,hostname,req.headers,res.headers',
                  },
                }
              : undefined,
          autoLogging: true,
          redact: ['req.headers.authorization', 'req.headers.cookie'],
        },
      }),
    }),
  ],
  controllers: [AppController],
  providers: [
    AppService,
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
    // Idempotency is registered first → it is the OUTER interceptor, so it
    // captures and replays the fully-enveloped response (FinMatrixGuide §6.3).
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
