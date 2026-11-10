import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { promises as dns } from 'dns';
import { emailTemplates, RenderedEmail } from './mail.templates';
import {
  deliverabilityWarnings,
  emailDomain,
  senderDnsWarnings,
} from './mail-deliverability';

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
      // Configuration that lands mail in spam is invisible from here, so say so.
      for (const warning of deliverabilityWarnings({
        from: this.config.get<string>('mail.from', ''),
        smtpUser: this.config.get<string>('mail.user', ''),
        webAppUrl: this.webAppUrl(),
      })) {
        this.logger.warn(`Email deliverability: ${warning}`);
      }
      // DNS lookups take a moment; never hold up boot for them.
      void this.logSenderDnsWarnings();
    } catch (err) {
      this.logger.error(
        `Failed to initialise SMTP transport — falling back to console. ${(err as Error).message}`,
      );
      this.transport = null;
    }
  }

  /** Warn about SPF / DMARC the sending domain is missing. Never throws. */
  protected async logSenderDnsWarnings(): Promise<void> {
    try {
      const domain = emailDomain(this.config.get<string>('mail.from', ''));
      for (const warning of await senderDnsWarnings(domain, dns.resolveTxt)) {
        this.logger.warn(`Email deliverability: ${warning}`);
      }
    } catch (err) {
      this.logger.debug(`Sender DNS check skipped: ${(err as Error).message}`);
    }
  }

  // ── High-level senders ──────────────────────────────────────────────────

  /**
   * The links an email-verification token travels in.
   *
   * `appLink` is the one the email leads with: the web app's own verify page,
   * over https, so it opens in any mail client and carries the owner straight
   * on into company setup. `deepLink` opens the Android app directly, for an
   * owner reading on the phone the app is on. `webLink` is the API's own
   * fallback page, which links sent before `appLink` existed still point at.
   */
  buildVerificationLinks(token: string): { appLink: string; deepLink: string; webLink: string } {
    const scheme = this.config.get<string>('mail.appScheme', 'finmatrix');
    const webBase = this.config.get<string>('mail.webFallbackBaseUrl', '');
    const webAppUrl = this.config.get<string>('mail.webAppUrl', '');
    const t = encodeURIComponent(token);
    return {
      appLink: `${webAppUrl}/verify-email?token=${t}`,
      deepLink: `${scheme}://verify-email?token=${t}`,
      webLink: `${webBase}/verify?token=${t}`,
    };
  }

  /** Where the product lives for an owner, with no trailing slash. */
  webAppUrl(): string {
    return this.config.get<string>('mail.webAppUrl', '');
  }

  /** The app's deep-link scheme, e.g. `finmatrix`. */
  appScheme(): string {
    return this.config.get<string>('mail.appScheme', 'finmatrix');
  }

  async sendVerificationEmail(to: string, displayName: string, token: string): Promise<void> {
    const { appLink } = this.buildVerificationLinks(token);
    await this.send(to, emailTemplates.verification(displayName, appLink));
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
    await this.send(to, emailTemplates.approved(displayName, companyName, this.webAppUrl()));
  }

  async sendDeactivatedEmail(to: string, displayName: string, companyName: string): Promise<void> {
    await this.send(to, emailTemplates.deactivated(displayName, companyName));
  }

  async sendReactivatedEmail(to: string, displayName: string, companyName: string): Promise<void> {
    await this.send(to, emailTemplates.reactivated(displayName, companyName, this.webAppUrl()));
  }

  async sendRejectionEmail(
    to: string,
    displayName: string,
    companyName: string,
    reason: string,
  ): Promise<void> {
    await this.send(to, emailTemplates.rejected(displayName, companyName, reason));
  }

  // ── Free trial ──────────────────────────────────────────────────────────

  async sendTrialRequestedEmail(to: string, displayName: string, companyName: string): Promise<void> {
    await this.send(to, emailTemplates.trialRequested(displayName, companyName));
  }

  /** Tells the platform admin a trial is waiting (the user was promised 24 hours). */
  async sendTrialRequestedAdminNotice(
    companyName: string,
    ownerEmail: string,
    ownerPhone: string | null,
  ): Promise<void> {
    const adminEmail = this.config.get<string>('mail.platformAdminEmail');
    if (!adminEmail) {
      this.logger.warn('No ADMIN_EMAIL configured — skipping trial request notice.');
      return;
    }
    await this.send(adminEmail, emailTemplates.trialRequestedAdmin(companyName, ownerEmail, ownerPhone));
  }

  async sendTrialApprovedEmail(
    to: string,
    displayName: string,
    companyName: string,
    trialEndsAt: Date,
  ): Promise<void> {
    await this.send(to, emailTemplates.trialApproved(displayName, companyName, trialEndsAt));
  }

  async sendTrialRejectedEmail(
    to: string,
    displayName: string,
    companyName: string,
    reason: string,
  ): Promise<void> {
    await this.send(to, emailTemplates.trialRejected(displayName, companyName, reason));
  }

  async sendTrialEndingEmail(
    to: string,
    displayName: string,
    companyName: string,
    daysRemaining: number,
  ): Promise<void> {
    await this.send(to, emailTemplates.trialEnding(displayName, companyName, daysRemaining));
  }

  async sendTrialEndedEmail(to: string, displayName: string, companyName: string): Promise<void> {
    await this.send(to, emailTemplates.trialEnded(displayName, companyName));
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
      const replyTo = this.config.get<string>('mail.replyTo');
      await this.transport.sendMail({
        from,
        to,
        ...(replyTo ? { replyTo } : {}),
        // A subject is a single header line; a company name with a line break
        // in it must not be able to start a new header.
        subject: email.subject.replace(/[\r\n]+/g, ' ').trim(),
        text: email.text,
        html: email.html,
        headers: {
          // RFC 3834: generated by a system, not written by a person. Stops
          // out-of-office replies and is how filters expect transactional
          // mail to identify itself.
          'Auto-Submitted': 'auto-generated',
          // Unique per message, so Gmail does not fold a re-sent verification
          // email into the earlier thread, where it looks like it never came.
          'X-Entity-Ref-ID': randomUUID(),
        },
      });
      this.logger.log(`Email sent to ${to}: "${email.subject}"`);
    } catch (err) {
      // Never let a mail failure break the calling flow.
      this.logger.error(`Failed to send email to ${to}: ${(err as Error).message}`);
    }
  }
}
