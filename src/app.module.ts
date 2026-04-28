import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule, TypeOrmModuleOptions } from '@nestjs/typeorm';
import { ThrottlerModule, ThrottlerGuard } from '@nestjs/throttler';
import { LoggerModule } from 'nestjs-pino';

import appConfig from './config/app.config';
import databaseConfig from './config/database.config';
import jwtConfig from './config/jwt.config';

import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { ResponseEnvelopeInterceptor } from './common/interceptors/response-envelope.interceptor';

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
import { PaymentsModule } from './modules/payments/payments.module';
import { EstimatesModule } from './modules/estimates/estimates.module';
import { SalesOrdersModule } from './modules/sales-orders/sales-orders.module';
import { CreditMemosModule } from './modules/credit-memos/credit-memos.module';
import { VendorsModule } from './modules/vendors/vendors.module';
import { BillsModule } from './modules/bills/bills.module';
import { PurchaseOrdersModule } from './modules/purchase-orders/purchase-orders.module';
import { VendorCreditsModule } from './modules/vendor-credits/vendor-credits.module';

// Module 2
import { AgenciesModule } from './modules/agencies/agencies.module';
import { InventoryModule } from './modules/inventory/inventory.module';
import { DeliveryPersonnelModule } from './modules/delivery-personnel/delivery-personnel.module';
import { DeliveriesModule } from './modules/deliveries/deliveries.module';
import { InventoryApprovalsModule } from './modules/inventory-approvals/inventory-approvals.module';
import { ShadowInventoryModule } from './modules/shadow-inventory/shadow-inventory.module';
import { BankingModule } from './modules/banking/banking.module';
import { EmployeesModule } from './modules/employees/employees.module';
import { PayrollModule } from './modules/payroll/payroll.module';
import { BudgetsModule } from './modules/budgets/budgets.module';
import { TaxModule } from './modules/tax/tax.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { AuditModule } from './modules/audit/audit.module';
import { SettingsModule } from './modules/settings/settings.module';
import { ReportsModule } from './modules/reports/reports.module';
import { HealthModule } from './modules/health/health.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { envValidationSchema } from './config/env.validation';
import { StorageModule } from './common/storage/storage.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [appConfig, databaseConfig, jwtConfig],
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
    UsersModule,
    AuthModule,
    CompaniesModule,
    AccountsModule,
    LedgerModule,
    JournalEntriesModule,
    CustomersModule,
    InvoicesModule,
    PaymentsModule,
    EstimatesModule,
    SalesOrdersModule,
    CreditMemosModule,
    VendorsModule,
    BillsModule,
    PurchaseOrdersModule,
    VendorCreditsModule,
    AgenciesModule,
    InventoryModule,
    DeliveryPersonnelModule,
    DeliveriesModule,
    InventoryApprovalsModule,
    ShadowInventoryModule,
    BankingModule,
    EmployeesModule,
    PayrollModule,
    BudgetsModule,
    TaxModule,
    NotificationsModule,
    AuditModule,
    SettingsModule,
    ReportsModule,
    HealthModule,
    StorageModule,
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
    { provide: APP_INTERCEPTOR, useClass: ResponseEnvelopeInterceptor },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(RequestIdMiddleware).forRoutes('*');
  }
}
