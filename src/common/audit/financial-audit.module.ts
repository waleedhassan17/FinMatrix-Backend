import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditTrailEntry } from './audit-trail.entity';
import { AuditTrailController } from './audit-trail.controller';
import { FinancialAuditService } from './financial-audit.service';
import { FinancialAuditSubscriber } from './financial-audit.subscriber';

/**
 * Financial audit trail (audit gap G2).
 *
 * Global so the subscriber is instantiated once at boot and registers itself
 * on the DataSource; no module needs to import anything for its documents to
 * be audited.
 */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([AuditTrailEntry])],
  controllers: [AuditTrailController],
  providers: [FinancialAuditService, FinancialAuditSubscriber],
  exports: [FinancialAuditService],
})
export class FinancialAuditModule {}
