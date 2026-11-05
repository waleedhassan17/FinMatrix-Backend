import { Injectable, Logger } from '@nestjs/common';
import { maskPhone } from '../../../common/utils/phone.util';
import { ProviderError } from '../meta-error-map';
import {
  MediaFile,
  ProviderCredentials,
  TemplateSend,
  TextSend,
  WhatsAppProvider,
} from './whatsapp-provider';

/**
 * WhatsApp Cloud API (graph.facebook.com). Used only when WHATSAPP_ENABLED=true,
 * and only by the dispatcher — never from a request handler and never inside a
 * database transaction.
 *
 * 1. POST /{phone-number-id}/media      multipart PDF            -> media id
 * 2. POST /{phone-number-id}/messages   template, document header -> wamid
 *
 * The Graph version comes from WHATSAPP_GRAPH_VERSION; it is never hard-coded.
 */
@Injectable()
export class MetaCloudProvider implements WhatsAppProvider {
  readonly kind = 'meta' as const;
  private readonly logger = new Logger(MetaCloudProvider.name);

  async uploadMedia(
    creds: ProviderCredentials,
    file: MediaFile,
  ): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', file.mimeType);
    form.append(
      'file',
      new Blob([new Uint8Array(file.buffer)], { type: file.mimeType }),
      file.filename,
    );
    const json = await this.call(creds, 'media', {
      method: 'POST',
      body: form,
    });
    const id = (json as { id?: string }).id;
    if (!id)
      throw new ProviderError('WhatsApp returned no media id', null, 200, json);
    return id;
  }

  async sendTemplate(
    creds: ProviderCredentials,
    msg: TemplateSend,
  ): Promise<{ providerMessageId: string }> {
    const components: Array<Record<string, unknown>> = [];
    if (msg.documentHeader) {
      components.push({
        type: 'header',
        parameters: [
          {
            type: 'document',
            document: {
              id: msg.documentHeader.mediaId,
              filename: msg.documentHeader.filename,
            },
          },
        ],
      });
    }
    if (msg.bodyParams.length > 0) {
      components.push({
        type: 'body',
        parameters: msg.bodyParams.map((text) => ({ type: 'text', text })),
      });
    }
    if (msg.urlButtonParam) {
      components.push({
        type: 'button',
        sub_type: 'url',
        index: '0',
        parameters: [{ type: 'text', text: msg.urlButtonParam }],
      });
    }
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: msg.to.replace(/^\+/, ''),
      type: 'template',
      template: {
        name: msg.templateName,
        language: { code: msg.language },
        components,
      },
    };
    const json = (await this.call(creds, 'messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })) as { messages?: Array<{ id?: string }> };
    const id = json.messages?.[0]?.id;
    if (!id)
      throw new ProviderError(
        'WhatsApp returned no message id',
        null,
        200,
        json,
      );
    this.logger.log(`sent ${msg.templateName} to ${maskPhone(msg.to)} (${id})`);
    return { providerMessageId: id };
  }

  /** A plain-text reply (a "service" message: free within Meta's monthly tier). */
  async sendText(
    creds: ProviderCredentials,
    msg: TextSend,
  ): Promise<{ providerMessageId: string }> {
    const body = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: msg.to.replace(/^\+/, ''),
      type: 'text',
      text: { preview_url: false, body: msg.body },
    };
    const json = (await this.call(creds, 'messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })) as { messages?: Array<{ id?: string }> };
    const id = json.messages?.[0]?.id;
    if (!id)
      throw new ProviderError(
        'WhatsApp returned no message id',
        null,
        200,
        json,
      );
    this.logger.log(`sent a text reply to ${maskPhone(msg.to)} (${id})`);
    return { providerMessageId: id };
  }

  private async call(
    creds: ProviderCredentials,
    path: string,
    init: RequestInit,
  ): Promise<unknown> {
    if (!creds.phoneNumberId || !creds.accessToken || !creds.graphVersion) {
      throw new ProviderError(
        'WhatsApp is not configured (phone number id, token or Graph version missing)',
        'not_configured',
        400,
      );
    }
    const url = `https://graph.facebook.com/${creds.graphVersion}/${encodeURIComponent(creds.phoneNumberId)}/${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          Authorization: `Bearer ${creds.accessToken}`,
        },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (err) {
      throw new ProviderError(
        `Could not reach WhatsApp: ${(err as Error).message}`,
        null,
        null,
      );
    }
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) {
      const e = (
        json as {
          error?: { code?: number; message?: string; error_subcode?: number };
        } | null
      )?.error;
      throw new ProviderError(
        e?.message || `WhatsApp answered ${res.status}`,
        e?.code ?? null,
        res.status,
        json,
      );
    }
    return json;
  }
}
