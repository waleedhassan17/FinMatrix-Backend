import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AuditTrail } from './entities/audit-trail.entity';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { AuditLogsController } from './audit-logs.controller';

@Module({
  imports: [TypeOrmModule.forFeature([AuditTrail])],
  providers: [AuditService],
  controllers: [AuditController, AuditLogsController],
  exports: [AuditService],
})
export class AuditModule {}
