import { Controller, Get } from '@nestjs/common';
import { PublicRoute } from '../../common/decorators/public.decorator';
import {
  HealthCheckService,
  HealthCheck,
  TypeOrmHealthIndicator,
  MemoryHealthIndicator,
  DiskHealthIndicator,
} from '@nestjs/terminus';

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private db: TypeOrmHealthIndicator,
    private memory: MemoryHealthIndicator,
    private disk: DiskHealthIndicator,
  ) {}

  @Get()
  @HealthCheck()
  liveness() {
    return this.health.check([]);
  }

  // TEMPORARY (phase6 verification): throws so the deployed app sends a test
  // error to Sentry. REMOVE after the event is confirmed in the dashboard.
  @Get('debug-sentry')
  @PublicRoute()
  debugSentry(): never {
    throw new Error('Sentry verification test error (phase6) — safe to ignore');
  }

  @Get('db')
  @HealthCheck()
  database() {
    return this.health.check([() => this.db.pingCheck('database', { timeout: 1500 })]);
  }

  @Get('ready')
  @HealthCheck()
  readiness() {
    return this.health.check([
      () => this.db.pingCheck('database', { timeout: 1500 }),
      () => this.memory.checkHeap('memory_heap', 250 * 1024 * 1024),
      () => this.disk.checkStorage('disk', { path: '/', thresholdPercent: 0.9 }),
    ]);
  }
}
