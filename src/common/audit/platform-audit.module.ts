import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { PlatformAuditEvent } from './platform-audit-event.entity';
import { PlatformAuditService } from './platform-audit.service';

/** Global so any module can inject PlatformAuditService without imports. */
@Global()
@Module({
  imports: [TypeOrmModule.forFeature([PlatformAuditEvent])],
  providers: [PlatformAuditService],
  exports: [PlatformAuditService],
})
export class PlatformAuditModule {}
