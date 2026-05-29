import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { emailTemplates, RenderedEmail } from './mail.templates';

/**
 * SMTP mailer with a console/dev fallback.
 *
 * - When EMAIL_ENABLED=true a nodemailer SMTP transport is created (the
 *   `nodemailer` package is imported lazily so the dev/console path has no
 *   hard dependency).
 * - When EMAIL_ENABLED=false every email is logged to the console, including
 *   verification links and OTPs, so the full flow is testable without SMTP.
 */
@Injectable()
export class MailService implements OnModuleInit {
  private readonly logger = new Logger(MailService.name);
  private transport: { sendMail: (opts: unknown) => Promise<unknown> } | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    if (!this.config.get<boolean>('mail.enabled')) {
      this.logger.warn(
        'EMAIL_ENABLED=false — emails will be logged to the console (dev transport).',
      );
      return;
    }
    try {
      // Lazy, indirect import so the build does not require `nodemailer` to be
      // installed unless SMTP is actually enabled. Install it with:
      //   npm install nodemailer @types/nodemailer
      const moduleName = 'nodemailer';
      const mod: any = await import(moduleName as string);
      const nodemailer = mod?.default ?? mod;
      if (!nodemailer?.createTransport) {
        throw new Error('nodemailer is not installed (run: npm install nodemailer)');
      }
      this.transport = nodemailer.createTransport({
        host: this.config.get<string>('mail.host'),
        port: this.config.get<number>('mail.port'),
        secure: this.config.get<boolean>('mail.secure'),
        auth: {
          user: this.config.get<string>('mail.user'),
          pass: this.config.get<string>('mail.pass'),
        },
      });
      this.logger.log(
        `SMTP transport ready (${this.config.get<string>('mail.host')}:${this.config.get<number>('mail.port')})`,
      );
    } catch (err) {
      this.logger.error(
        `Failed to initialise SMTP transport — falling back to console. ${(err as Error).message}`,
      );
      this.transport = null;
    }
  }

  // ── High-level senders ──────────────────────────────────────────────────

  /** Builds the app deep link + web fallback URL for an email-verification token. */
  buildVerificationLinks(token: string): { deepLink: string; webLink: string } {
    const scheme = this.config.get<string>('mail.appScheme', 'finmatrix');
    const webBase = this.config.get<string>('mail.webFallbackBaseUrl', '');
    return {
      deepLink: `${scheme}://verify-email?token=${encodeURIComponent(token)}`,
      webLink: `${webBase}/verify?token=${encodeURIComponent(token)}`,
    };
  }

  async sendVerificationEmail(to: string, displayName: string, token: string): Promise<void> {
    const { deepLink, webLink } = this.buildVerificationLinks(token);
    await this.send(to, emailTemplates.verification(displayName, deepLink, webLink));
  }

  async sendOtpEmail(to: string, displayName: string, otp: string): Promise<void> {
    const ttl = this.config.get<number>('mail.otpTtlMinutes', 10);
    await this.send(to, emailTemplates.otp(displayName, otp, ttl));
  }

  async sendCompanySubmittedNotice(companyName: string, ownerEmail: string): Promise<void> {
    const adminEmail = this.config.get<string>('mail.platformAdminEmail');
    if (!adminEmail) {
      this.logger.warn('No ADMIN_EMAIL configured — skipping submission notice.');
      return;
    }
    await this.send(adminEmail, emailTemplates.companySubmitted(companyName, ownerEmail));
  }

  async sendApprovalEmail(to: string, displayName: string, companyName: string): Promise<void> {
    await this.send(to, emailTemplates.approved(displayName, companyName));
  }

  async sendRejectionEmail(
    to: string,
    displayName: string,
    companyName: string,
    reason: string,
  ): Promise<void> {
    await this.send(to, emailTemplates.rejected(displayName, companyName, reason));
  }

  // ── Low-level send ──────────────────────────────────────────────────────

  private async send(to: string, email: RenderedEmail): Promise<void> {
    const from = this.config.get<string>('mail.from');
    if (!this.transport) {
      // Dev/console transport — surface everything needed to test the flow.
      this.logger.log(
        `\n──────── [DEV EMAIL] ────────\nTo: ${to}\nFrom: ${from}\nSubject: ${email.subject}\n\n${email.text}\n─────────────────────────────`,
      );
      return;
    }
    try {
      await this.transport.sendMail({
        from,
        to,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });
      this.logger.log(`Email sent to ${to}: "${email.subject}"`);
    } catch (err) {
      // Never let a mail failure break the calling flow.
      this.logger.error(`Failed to send email to ${to}: ${(err as Error).message}`);
    }
  }
}
