import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller';
import { ClientErrorsController } from './client-errors.controller';

@Module({
  imports: [TerminusModule],
  controllers: [HealthController, ClientErrorsController],
})
export class HealthModule {}
