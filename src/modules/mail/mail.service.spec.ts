import * as nodemailer from 'nodemailer';
import { ConfigService } from '@nestjs/config';
import { MailService } from './mail.service';
import { emailTemplates } from './mail.templates';

/** A ConfigService over a plain map, the way MailService reads it. */
function configWith(values: Record<string, unknown>): ConfigService {
  return {
    get: (key: string, fallback?: unknown) =>
      key in values ? values[key] : fallback,
  } as unknown as ConfigService;
}

const baseConfig = {
  'mail.enabled': true,
  'mail.host': 'smtp.example.com',
  'mail.port': 587,
  'mail.secure': false,
  'mail.user': 'AKIAEXAMPLE',
  'mail.pass': 'secret',
  'mail.from': 'FinMatrix <no-reply@finmatrix.pk>',
  'mail.webAppUrl': 'https://app.finmatrix.pk',
  'mail.webFallbackBaseUrl': 'https://api.finmatrix.pk/api/v1/auth',
  'mail.appScheme': 'finmatrix',
  'mail.platformAdminEmail': 'admin@finmatrix.pk',
};

interface Captured {
  options: Record<string, any>;
  raw: string;
}

/**
 * A MailService whose real SMTP transport has been built (proving the lazy
 * nodemailer import works) and then swapped for nodemailer's stream
 * transport, so every message is rendered to raw MIME instead of sent.
 */
async function serviceCapturing(extra: Record<string, unknown> = {}) {
  const service = new MailService(configWith({ ...baseConfig, ...extra }));
  await service.onModuleInit();
  const internals = service as unknown as { transport: unknown };
  expect(internals.transport).not.toBeNull();

  const stream = nodemailer.createTransport({
    streamTransport: true,
    buffer: true,
    newline: 'unix',
  });
  const sent: Captured[] = [];
  internals.transport = {
    sendMail: async (options: Record<string, any>) => {
      const info = await stream.sendMail(options);
      sent.push({ options, raw: (info.message as Buffer).toString('utf8') });
      return info;
    },
  };
  return { service, sent };
}

const headerBlock = (raw: string) => raw.split('\n\n')[0];

describe('MailService', () => {
  // The startup DNS check is covered in mail-deliverability.spec.ts; unit
  // tests must not depend on the network.
  beforeEach(() => {
    jest
      .spyOn(MailService.prototype as any, 'logSenderDnsWarnings')
      .mockResolvedValue(undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('builds a real SMTP transport from the installed nodemailer', async () => {
    const service = new MailService(configWith(baseConfig));
    await service.onModuleInit();
    const transport = (
      service as unknown as { transport: { sendMail?: unknown } | null }
    ).transport;
    expect(typeof transport?.sendMail).toBe('function');
  });

  it('sends the verification email as text + HTML, with automated-mail headers', async () => {
    const { service, sent } = await serviceCapturing();
    await service.sendVerificationEmail(
      'owner@example.com',
      'Ayesha',
      'tok-123',
    );

    expect(sent).toHaveLength(1);
    const { options, raw } = sent[0];
    const headers = headerBlock(raw);
    expect(headers).toMatch(/^From: FinMatrix <no-reply@finmatrix\.pk>$/m);
    expect(headers).toMatch(/^Auto-Submitted: auto-generated$/m);
    expect(headers).toMatch(/^X-Entity-Ref-ID: [0-9a-f-]{36}$/m);
    expect(headers).toMatch(/^Message-ID: <.+@finmatrix\.pk>$/m);
    expect(headers).toMatch(/^Content-Type: multipart\/alternative;/m);
    expect(raw).toMatch(/^Content-Type: text\/plain; charset=utf-8$/m);
    expect(raw).toMatch(/^Content-Type: text\/html; charset=utf-8$/m);

    // One https link, in both parts, and no custom-scheme link anywhere.
    const link = 'https://app.finmatrix.pk/verify-email?token=tok-123';
    expect(options.text).toContain(link);
    expect(options.html).toContain(`href="${link}"`);
    expect(`${options.text}${options.html}`).not.toContain('finmatrix://');
  });

  it('gives each message its own X-Entity-Ref-ID, so re-sends are not folded into one thread', async () => {
    const { service, sent } = await serviceCapturing();
    await service.sendVerificationEmail('owner@example.com', 'Ayesha', 'a');
    await service.sendVerificationEmail('owner@example.com', 'Ayesha', 'b');
    const ids = sent.map((m) => /^X-Entity-Ref-ID: (.+)$/m.exec(m.raw)?.[1]);
    expect(ids[0]).toBeTruthy();
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('adds Reply-To only when one is configured', async () => {
    const without = await serviceCapturing();
    await without.service.sendVerificationEmail('o@example.com', 'O', 't');
    expect(headerBlock(without.sent[0].raw)).not.toMatch(/^Reply-To:/m);

    const withReply = await serviceCapturing({
      'mail.replyTo': 'support@finmatrix.pk',
    });
    await withReply.service.sendVerificationEmail('o@example.com', 'O', 't');
    expect(headerBlock(withReply.sent[0].raw)).toMatch(
      /^Reply-To: support@finmatrix\.pk$/m,
    );
  });

  it('keeps a typed company name from starting a new header', async () => {
    const { service, sent } = await serviceCapturing();
    await service.sendCompanySubmittedNotice(
      'Acme\r\nBcc: victim@example.com',
      'owner@example.com',
    );
    const headers = headerBlock(sent[0].raw);
    expect(headers).not.toMatch(/^Bcc:/m);
    expect(sent[0].options.subject).not.toMatch(/[\r\n]/);
  });

  it('falls back to the console when email is disabled', async () => {
    const service = new MailService(
      configWith({ ...baseConfig, 'mail.enabled': false }),
    );
    await service.onModuleInit();
    expect((service as unknown as { transport: unknown }).transport).toBeNull();
    await expect(
      service.sendVerificationEmail('o@example.com', 'O', 't'),
    ).resolves.toBeUndefined();
  });
});

describe('email templates', () => {
  it('every template is a complete HTML document with a title', () => {
    const rendered = [
      emailTemplates.verification(
        'A',
        'https://app.example.com/verify-email?token=t',
      ),
      emailTemplates.otp('A', '123456', 10),
      emailTemplates.companySubmitted('Acme', 'a@example.com'),
      emailTemplates.approved('A', 'Acme', 'https://app.example.com'),
      emailTemplates.rejected('A', 'Acme', 'Incomplete'),
      emailTemplates.trialEnded('A', 'Acme'),
    ];
    for (const email of rendered) {
      expect(email.html).toMatch(
        /^<!doctype html>\s*<html lang="en">\s*<head>/,
      );
      expect(email.html).toContain('<meta charset="utf-8" />');
      expect(email.html).toMatch(/<title>[^<]+<\/title>/);
      expect(email.text.length).toBeGreaterThan(0);
    }
  });

  it('escapes what people typed, above all in mail to the platform admin', () => {
    const evil = '<a href="https://phish.example">Click</a>';
    const admin = emailTemplates.companySubmitted(evil, `x@example.com${evil}`);
    expect(admin.html).not.toContain('<a href="https://phish.example">');
    expect(admin.html).toContain(
      '&lt;a href=&quot;https://phish.example&quot;&gt;',
    );

    expect(emailTemplates.otp(evil, '123456', 10).html).not.toContain(
      '<a href="https://phish.example">',
    );
    expect(emailTemplates.rejected(evil, evil, evil).html).not.toContain(
      '<a href="https://phish.example">',
    );
  });
});
