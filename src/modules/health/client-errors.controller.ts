import { Body, Controller, HttpCode, Logger, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { IsIn, IsObject, IsOptional, IsString, MaxLength } from 'class-validator';
import * as Sentry from '@sentry/nestjs';
import { CurrentUser, AuthenticatedUser } from '../../common/decorators/current-user.decorator';

class ClientErrorDto {
  @IsString() @MaxLength(2000) message!: string;
  @IsOptional() @IsString() @MaxLength(8000) stack?: string;
  @IsOptional() @IsString() @MaxLength(200) screen?: string;
  @IsOptional() @IsIn(['ios', 'android', 'web']) platform?: string;
  @IsOptional() @IsIn(['error', 'unhandled_rejection']) kind?: string;
  @IsOptional() @IsObject() extra?: Record<string, unknown>;
}

/**
 * Client-side error intake (phase3 Chunk 1): the mobile/web app reports
 * unhandled JS errors here; they land in the server log and — when
 * SENTRY_DSN is configured — in Sentry with device context. Auth comes
 * from the global JwtAuthGuard, so reports are tied to a real user.
 */
@ApiTags('monitoring')
@ApiBearerAuth()
@Controller('monitoring')
export class ClientErrorsController {
  private readonly logger = new Logger('ClientError');

  @Post('client-errors')
  @HttpCode(202)
  @ApiOperation({ summary: 'Report an unhandled client-side error' })
  report(@Body() dto: ClientErrorDto, @CurrentUser() user: AuthenticatedUser) {
    this.logger.error(
      `[${dto.platform ?? '?'}] ${dto.kind ?? 'error'} on ${dto.screen ?? 'unknown screen'} ` +
        `(user ${user?.id ?? 'anonymous'}): ${dto.message}` +
        (dto.stack ? `\n${dto.stack}` : ''),
    );
    Sentry.withScope((scope) => {
      scope.setTag('source', 'client');
      scope.setTag('platform', dto.platform ?? 'unknown');
      scope.setTag('screen', dto.screen ?? 'unknown');
      scope.setUser({ id: user?.id ?? 'anonymous' });
      if (dto.extra) scope.setContext('extra', dto.extra);
      const err = new Error(dto.message);
      if (dto.stack) err.stack = dto.stack;
      Sentry.captureException(err);
    });
    return { received: true };
  }
}
