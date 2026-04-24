import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';
import { PublicRoute } from './common/decorators/public.decorator';

@ApiTags('health')
@Controller('health')
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @PublicRoute()
  @ApiOperation({ summary: 'Liveness + build info' })
  getHealth() {
    return this.appService.getHealth();
  }
}
