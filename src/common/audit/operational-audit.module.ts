import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { OperationalAuditEvent } from './operational-audit-event.entity';
import { OperationalAuditService } from './operational-audit.service';

/** Global so any module can inject OperationalAuditService without imports. */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([OperationalAuditEvent])],
  providers: [OperationalAuditService],
  exports: [OperationalAuditService],
})
export class OperationalAuditModule {}
