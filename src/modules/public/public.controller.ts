import { Controller, Get, Header } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PublicRoute } from '../../common/decorators/public.decorator';
import { publicLaunchConfig } from '../../config/launch.settings';

/**
 * Unauthenticated, read-only launch configuration. Clients read it on start so
 * the sign-up paths, trial length, demo booking and support contacts change
 * with an env var on the server — no app or web rebuild.
 *
 * It exposes switches and public contacts only: never a secret, never any
 * company's data.
 */
@ApiTags('Public')
@Controller('public')
export class PublicController {
  @PublicRoute()
  @Get('config')
  @Header('Cache-Control', 'public, max-age=60')
  @ApiOperation({ summary: 'Public launch configuration (cached 60 s).' })
  config() {
    return publicLaunchConfig();
  }
}
