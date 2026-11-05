/** Who sends: shared FinMatrix credentials (env) or the company's own. */
export interface ProviderCredentials {
  phoneNumberId: string;
  accessToken: string;
  graphVersion: string;
}

export interface MediaFile {
  buffer: Buffer;
  filename: string;
  mimeType: string;
}

export interface TemplateSend {
  /** E.164 with '+'. */
  to: string;
  templateName: string;
  language: string;
  /** Document header (media id from uploadMedia), when the template has one. */
  documentHeader?: { mediaId: string; filename: string } | null;
  bodyParams: string[];
  /** Value for the template's URL button suffix, when it has one. */
  urlButtonParam?: string | null;
  /** For logs and the fake provider only. */
  preview?: string;
}

/** A plain-text message: only allowed as a reply within 24 h of the contact writing. */
export interface TextSend {
  /** E.164 with '+'. */
  to: string;
  body: string;
}

export interface WhatsAppProvider {
  readonly kind: 'meta' | 'fake';
  uploadMedia(creds: ProviderCredentials, file: MediaFile): Promise<string>;
  sendTemplate(
    creds: ProviderCredentials,
    msg: TemplateSend,
  ): Promise<{ providerMessageId: string }>;
  sendText(
    creds: ProviderCredentials,
    msg: TextSend,
  ): Promise<{ providerMessageId: string }>;
}

export const WHATSAPP_PROVIDER = Symbol('WHATSAPP_PROVIDER');
