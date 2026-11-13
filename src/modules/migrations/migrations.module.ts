import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AccountsModule } from '../accounts/accounts.module';
import { InventoryModule } from '../inventory/inventory.module';
import { JournalEntriesModule } from '../journal-entries/journal-entries.module';
import { MigrationAnalysisService } from './analysis/migration-analysis.service';
import {
  MIGRATION_AI_CLIENT,
  MigrationAiService,
} from './ai/migration-ai.service';
import { MigrationAiClient } from './ai/ai-mapping-session';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';
import { MigrationCommitService } from './commit/migration-commit.service';
import { MigrationRollbackService } from './commit/migration-rollback.service';
import { MigrationBatch } from './entities/migration-batch.entity';
import { MigrationBatchRecord } from './entities/migration-batch-record.entity';
import { MigrationFile } from './entities/migration-file.entity';
import { MigrationIssue } from './entities/migration-issue.entity';
import { MigrationMapping } from './entities/migration-mapping.entity';
import { MigrationProfile } from './entities/migration-profile.entity';
import { MigrationStagingRow } from './entities/migration-staging-row.entity';
import { MigrationBatchService } from './migration-batch.service';
import { MigrationsController } from './migrations.controller';
import { MigrationChecksService } from './validation/migration-checks.service';

/**
 * Migration Center (Part B §1.3–1.8): bring a business's opening books in
 * from a spreadsheet or Tally, prove they reconcile, then post. Kept apart
 * from data-portability: one reads books out, this one writes them in.
 */
@Module({
  imports: [
    ConfigModule,
    TypeOrmModule.forFeature([
      MigrationBatch,
      MigrationFile,
      MigrationStagingRow,
      MigrationMapping,
      MigrationIssue,
      MigrationProfile,
      MigrationBatchRecord,
    ]),
    AccountsModule,
    InventoryModule,
    JournalEntriesModule,
  ],
  controllers: [MigrationsController],
  providers: [
    // The Anthropic client exists only when a key is configured; without one
    // the assistant reports itself disabled and nothing is ever sent out.
    {
      provide: MIGRATION_AI_CLIENT,
      inject: [ConfigService],
      useFactory: (config: ConfigService): MigrationAiClient | null => {
        const apiKey = config.get<string>('ANTHROPIC_API_KEY');
        if (!apiKey) return null;
        const sdk = new Anthropic({ apiKey, maxRetries: 2, timeout: 120_000 });
        return { create: (params) => sdk.beta.messages.create(params) };
      },
    },
    MigrationAiService,
    MigrationBatchService,
    MigrationAnalysisService,
    MigrationChecksService,
    MigrationCommitService,
    MigrationRollbackService,
  ],
  exports: [MigrationBatchService],
})
export class MigrationsModule {}
