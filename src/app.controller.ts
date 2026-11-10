import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import { AppService } from './app.service';
import { PublicRoute } from './common/decorators/public.decorator';

@ApiTags('health')
@Controller('health')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @PublicRoute()
  // Load-balancer probes hit this every few seconds; never rate-limit them.
  @SkipThrottle()
  @ApiOperation({ summary: 'Liveness + build info' })
  getHealth() {
    return this.appService.getHealth();
  }
}
