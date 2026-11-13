/**
 * In-process harness for the Migration Center: boots the Nest application
 * context once and drives MigrationBatchService directly, so hundreds of
 * generated companies can be migrated without hundreds of sign-ups through
 * the throttled auth routes. Used by test/migration-property.ts.
 */
import './migration-harness.env';
import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { randomBytes, randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { AppModule } from '../src/app.module';
import { AuthenticatedUser } from '../src/common/decorators/current-user.decorator';
import { DEFAULT_CHART_OF_ACCOUNTS } from '../src/modules/accounts/accounts.constants';
import { Account } from '../src/modules/accounts/entities/account.entity';
import { Company } from '../src/modules/companies/entities/company.entity';
import { MigrationBatchService } from '../src/modules/migrations/migration-batch.service';
import { ReportsService } from '../src/modules/reports/reports.service';

export interface Harness {
  app: INestApplicationContext;
  ds: DataSource;
  svc: MigrationBatchService;
  reports: ReportsService;
  close: () => Promise<void>;
}

export async function bootHarness(): Promise<Harness> {
  // Workers off, Cloudinary off, mail off: see migration-harness.env.ts,
  // which must be (and is) imported before AppModule.
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['error'],
  });
  assertIsolated(app.get(ConfigService));
  return {
    app,
    ds: app.get(DataSource),
    svc: app.get(MigrationBatchService),
    reports: app.get(ReportsService),
    close: () => app.close(),
  };
}

/**
 * Refuse to run against live services. A harness run creates thousands of
 * files and must never reach a developer's Cloudinary account or let its own
 * workers claim jobs the API queued.
 */
function assertIsolated(config: ConfigService): void {
  const live = [
    'CLOUDINARY_CLOUD_NAME',
    'CLOUDINARY_API_KEY',
    'CLOUDINARY_API_SECRET',
    'CLOUDINARY_URL',
  ].filter((k) => !!config.get<string>(k));
  const workers = ['EXPORT_WORKER_ENABLED', 'MESSAGING_WORKER_ENABLED'].filter(
    (k) => String(config.get(k)) !== 'false',
  );
  if (live.length || workers.length) {
    throw new Error(
      `Migration harness is not isolated: ${[...live, ...workers].join(', ')} still set. ` +
        'Import test/migration-harness.env.ts before anything that loads AppModule.',
    );
  }
}

/** A fresh warehouse-tier company with the default chart and no postings. */
export async function freshCompany(
  ds: DataSource,
  label: string,
): Promise<{ companyId: string; user: AuthenticatedUser }> {
  const userId = randomUUID();
  const company = await ds.manager.save(
    ds.manager.create(Company, {
      name: `Migration ${label}`,
      inviteCode: randomBytes(6).toString('hex').slice(0, 12).toUpperCase(),
      createdBy: userId,
      status: 'active',
      companyType: 'warehouse',
      inventoryEnabled: true,
      setupCompleted: true,
    } as Partial<Company>),
  );
  await ds.manager.save(
    DEFAULT_CHART_OF_ACCOUNTS.map((a) =>
      ds.manager.create(Account, {
        companyId: company.id,
        accountNumber: a.accountNumber,
        name: a.name,
        type: a.type,
        subType: a.subType,
        parentId: null,
        description: null,
        openingBalance: '0',
        balance: '0',
        isActive: true,
      }),
    ),
  );
  return {
    companyId: company.id,
    user: {
      id: userId,
      email: null,
      username: null,
      role: 'admin',
      companyId: company.id,
    },
  };
}

export const asUpload = (buffer: Buffer, name: string) => ({
  buffer,
  originalname: name,
  mimetype: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  size: buffer.length,
});
