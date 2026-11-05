import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { maskPhone } from '../../../common/utils/phone.util';
import { ProviderError } from '../meta-error-map';
import { MessageStatusService } from '../message-status.service';
import {
  MediaFile,
  ProviderCredentials,
  TemplateSend,
  TextSend,
  WhatsAppProvider,
} from './whatsapp-provider';

/**
 * Stands in for Meta when WHATSAPP_ENABLED=false (the default). Nothing leaves
 * the server. A send returns `fake-<uuid>` and, about 2 s later, reports
 * 'delivered' and then 'read' through MessageStatusService — the same code path
 * as Meta's webhook — so ticks move in the app and web exactly as they will
 * live.
 *
 * For tests, the recipient's number picks a failure:
 *   ends in 0000 -> 131026 "undeliverable" (permanent, clears verification)
 *   ends in 9999 -> 130429 rate limit (retryable)
 */
@Injectable()
export class FakeWhatsAppProvider implements WhatsAppProvider {
  readonly kind = 'fake' as const;
  private readonly logger = new Logger('FakeWhatsAppProvider');
  deliveredAfterMs = 2_000;
  readAfterMs = 4_000;

  constructor(private readonly status: MessageStatusService) {}

  async uploadMedia(
    _creds: ProviderCredentials,
    file: MediaFile,
  ): Promise<string> {
    this.logger.log(
      `[simulated] media upload ${file.filename} (${file.buffer.length} bytes)`,
    );
    return `fake-media-${randomUUID()}`;
  }

  async sendTemplate(
    _creds: ProviderCredentials,
    msg: TemplateSend,
  ): Promise<{ providerMessageId: string }> {
    if (msg.to.endsWith('0000')) {
      throw new ProviderError('(fake) Message undeliverable', 131026, 400);
    }
    if (msg.to.endsWith('9999')) {
      throw new ProviderError('(fake) Rate limit hit', 130429, 429);
    }
    this.logger.log(
      `[simulated] ${msg.templateName}/${msg.language} -> ${maskPhone(msg.to)}${msg.documentHeader ? ' +PDF' : ''}: ${msg.preview ?? ''}`,
    );
    return { providerMessageId: this.simulateDelivery() };
  }

  async sendText(
    _creds: ProviderCredentials,
    msg: TextSend,
  ): Promise<{ providerMessageId: string }> {
    this.logger.log(`[simulated] text -> ${maskPhone(msg.to)}: ${msg.body}`);
    return { providerMessageId: this.simulateDelivery() };
  }

  /** A fake id that reaches 'delivered' and then 'read' like a real message. */
  private simulateDelivery(): string {
    const id = `fake-${randomUUID()}`;
    const later = (ms: number, status: 'delivered' | 'read') =>
      setTimeout(() => {
        this.status
          .applyProviderStatus({
            providerMessageId: id,
            status,
            raw: { simulated: true },
          })
          .catch((err) =>
            this.logger.warn(
              `simulated ${status} failed: ${(err as Error).message}`,
            ),
          );
      }, ms).unref?.();
    later(this.deliveredAfterMs, 'delivered');
    later(this.readAfterMs, 'read');
    return id;
  }
}
