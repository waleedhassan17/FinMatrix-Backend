import {
  Body,
  Controller,
  Get,
  HttpCode,
  Logger,
  Post,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiExcludeController } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import { PublicRoute } from '../../../common/decorators/public.decorator';
import { MessageStatusService } from '../message-status.service';
import { verifyMetaSignature } from '../message-status.util';
import { envString } from '../messaging-env.util';

/**
 * Meta's WhatsApp webhook: /api/v1/webhooks/whatsapp.
 *
 * Public (Meta has no session) and outside FeatureGuard; the HMAC signature
 * over the raw body IS the authorisation. Statuses only move forward, STOP
 * opts the number out. Every verified POST is answered 200 even if one item
 * in it fails, so Meta does not retry a payload we have already recorded.
 *
 * The throttle is raised rather than removed: Meta batches but can burst.
 */
@ApiExcludeController()
@PublicRoute()
@Throttle({ default: { limit: 3_000, ttl: 60_000 } })
@Controller('webhooks/whatsapp')
export class WhatsAppWebhookController {
  private readonly logger = new Logger(WhatsAppWebhookController.name);

  constructor(
    private readonly config: ConfigService,
    private readonly status: MessageStatusService,
  ) {}

  /** Subscription handshake: echo hub.challenge when the verify token matches. */
  @Get()
  verify(@Query() query: Record<string, unknown>, @Res() res: Response) {
    const hub = (query.hub as Record<string, unknown> | undefined) ?? {};
    const mode = String(query['hub.mode'] ?? hub.mode ?? '');
    const token = String(query['hub.verify_token'] ?? hub.verify_token ?? '');
    const challenge = String(query['hub.challenge'] ?? hub.challenge ?? '');
    const expected = envString(this.config, 'WHATSAPP_WEBHOOK_VERIFY_TOKEN');
    if (mode === 'subscribe' && expected !== '' && token === expected) {
      res.status(200).type('text/plain').send(challenge);
      return;
    }
    res.status(403).type('text/plain').send('Forbidden');
  }

  @Post()
  @HttpCode(200)
  async receive(@Req() req: RawBodyRequest<Request>, @Body() body: unknown) {
    const secret = envString(this.config, 'WHATSAPP_APP_SECRET');
    if (
      !verifyMetaSignature(
        req.rawBody,
        req.headers['x-hub-signature-256'],
        secret,
      )
    ) {
      throw new UnauthorizedException({
        code: 'BAD_SIGNATURE',
        message: 'Webhook signature does not match',
      });
    }
    try {
      const counts = await this.status.processWebhook(body);
      return { received: true, ...counts };
    } catch (err) {
      this.logger.error(`webhook processing failed: ${(err as Error).message}`);
      return { received: true };
    }
  }
}
