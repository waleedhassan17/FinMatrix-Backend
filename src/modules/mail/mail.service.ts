import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { promises as dns } from 'dns';
import {
  DaySummaryEmailInput,
  emailTemplates,
  RenderedEmail,
} from './mail.templates';
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
  private transport: { sendMail: (opts: unknown) => Promise<unknown> } | null =
    null;

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
        throw new Error(
          'nodemailer is not installed (run: npm install nodemailer)',
        );
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
  buildVerificationLinks(token: string): {
    appLink: string;
    deepLink: string;
    webLink: string;
  } {
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

  async sendVerificationEmail(
    to: string,
    displayName: string,
    token: string,
  ): Promise<void> {
    const { appLink } = this.buildVerificationLinks(token);
    await this.send(to, emailTemplates.verification(displayName, appLink));
  }

  async sendOtpEmail(
    to: string,
    displayName: string,
    otp: string,
  ): Promise<void> {
    const ttl = this.config.get<number>('mail.otpTtlMinutes', 10);
    await this.send(to, emailTemplates.otp(displayName, otp, ttl));
  }

  async sendCompanySubmittedNotice(
    companyName: string,
    ownerEmail: string,
    requestedPlan: string | null = null,
    note: string | null = null,
  ): Promise<void> {
    const adminEmail = this.config.get<string>('mail.platformAdminEmail');
    if (!adminEmail) {
      this.logger.warn(
        'No ADMIN_EMAIL configured — skipping submission notice.',
      );
      return;
    }
    await this.send(
      adminEmail,
      emailTemplates.companySubmitted(
        companyName,
        ownerEmail,
        requestedPlan,
        note,
      ),
    );
  }

  async sendApprovalEmail(
    to: string,
    displayName: string,
    companyName: string,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.approved(displayName, companyName, this.webAppUrl()),
    );
  }

  async sendDeactivatedEmail(
    to: string,
    displayName: string,
    companyName: string,
  ): Promise<void> {
    await this.send(to, emailTemplates.deactivated(displayName, companyName));
  }

  async sendReactivatedEmail(
    to: string,
    displayName: string,
    companyName: string,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.reactivated(displayName, companyName, this.webAppUrl()),
    );
  }

  async sendRejectionEmail(
    to: string,
    displayName: string,
    companyName: string,
    reason: string,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.rejected(displayName, companyName, reason),
    );
  }

  // ── Free trial ──────────────────────────────────────────────────────────

  /** The platform admin inbox, or '' (callers skip with a warning). */
  private adminInbox(what: string): string {
    const adminEmail = this.config.get<string>('mail.platformAdminEmail');
    if (!adminEmail) {
      this.logger.warn(`No ADMIN_EMAIL configured — skipping ${what}.`);
      return '';
    }
    return adminEmail;
  }

  /** The Migration Center guide on the customer web app. */
  migrationGuideUrl(): string {
    const app = this.webAppUrl();
    return app ? `${app}/settings/migration/guide` : '';
  }

  /** The trial is held for review (risk signal, or auto-approve off). */
  async sendTrialRequestedEmail(
    to: string,
    displayName: string,
    companyName: string,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.trialRequested(displayName, companyName),
    );
  }

  /** Tells the platform admin a trial is waiting for a decision. */
  async sendTrialRequestedAdminNotice(
    companyName: string,
    ownerEmail: string,
    ownerPhone: string | null,
    holdReason: string | null = null,
  ): Promise<void> {
    const to = this.adminInbox('trial request notice');
    if (!to) return;
    await this.send(
      to,
      emailTemplates.trialRequestedAdmin(
        companyName,
        ownerEmail,
        ownerPhone,
        holdReason,
      ),
    );
  }

  /** FYI to the platform admin: a trial started automatically. */
  async sendTrialAutoApprovedAdminNotice(
    companyName: string,
    ownerEmail: string,
    ownerPhone: string | null,
    trialEndsAt: Date,
  ): Promise<void> {
    const to = this.adminInbox('auto-approved trial notice');
    if (!to) return;
    await this.send(
      to,
      emailTemplates.trialAutoApprovedAdmin(
        companyName,
        ownerEmail,
        ownerPhone,
        trialEndsAt,
      ),
    );
  }

  async sendTrialApprovedEmail(
    to: string,
    displayName: string,
    companyName: string,
    trialEndsAt: Date,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.trialApproved(displayName, companyName, trialEndsAt, {
        app: this.webAppUrl() || undefined,
        migrationGuide: this.migrationGuideUrl() || undefined,
      }),
    );
  }

  async sendTrialRejectedEmail(
    to: string,
    displayName: string,
    companyName: string,
    reason: string,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.trialRejected(displayName, companyName, reason),
    );
  }

  async sendTrialEndingEmail(
    to: string,
    displayName: string,
    companyName: string,
    daysRemaining: number,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.trialEnding(
        displayName,
        companyName,
        daysRemaining,
        this.webAppUrl() || undefined,
      ),
    );
  }

  async sendTrialEndedEmail(
    to: string,
    displayName: string,
    companyName: string,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.trialEnded(
        displayName,
        companyName,
        this.webAppUrl() || undefined,
      ),
    );
  }

  async sendTrialEndedEarlyEmail(
    to: string,
    displayName: string,
    companyName: string,
    reason: string,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.trialEndedEarly(displayName, companyName, reason),
    );
  }

  async sendTrialExtendedEmail(
    to: string,
    displayName: string,
    companyName: string,
    newEnd: Date,
    extraDays: number,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.trialExtended(displayName, companyName, newEnd, extraDays),
    );
  }

  // ── Activation (no payment gateway) ─────────────────────────────────────

  async sendActivationRequestedEmail(
    to: string,
    displayName: string,
    companyName: string,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.activationRequested(displayName, companyName),
    );
  }

  async sendActivationRequestedAdminNotice(
    companyName: string,
    ownerEmail: string,
    requestedPlan: string,
    note: string | null,
  ): Promise<void> {
    const to = this.adminInbox('activation request notice');
    if (!to) return;
    await this.send(
      to,
      emailTemplates.activationRequestedAdmin(
        companyName,
        ownerEmail,
        requestedPlan,
        note,
      ),
    );
  }

  /** A plan was switched on: an activation request or a path-B approval. */
  async sendPlanActivatedEmail(
    to: string,
    displayName: string,
    companyName: string,
    planLabel: string,
    endsAt: Date,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.planActivated(
        displayName,
        companyName,
        planLabel,
        endsAt,
        this.webAppUrl() || undefined,
      ),
    );
  }

  async sendActivationRejectedEmail(
    to: string,
    displayName: string,
    companyName: string,
    reason: string,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.activationRejected(displayName, companyName, reason),
    );
  }

  /** The owner's end-of-day digest (reports/day-summary-cron.service.ts). */
  async sendDaySummaryEmail(
    to: string,
    input: DaySummaryEmailInput,
  ): Promise<void> {
    await this.send(to, emailTemplates.daySummary(input));
  }

  // ── Low-level send ──────────────────────────────────────────────────────

  // ── Suspension ──────────────────────────────────────────────────────────

  async sendAccountSuspendedEmail(
    to: string,
    displayName: string,
    reason: string,
  ): Promise<void> {
    await this.send(to, emailTemplates.accountSuspended(displayName, reason));
  }

  async sendAccountReinstatedEmail(
    to: string,
    displayName: string,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.accountReinstated(
        displayName,
        this.webAppUrl() || undefined,
      ),
    );
  }

  async sendCompanySuspendedEmail(
    to: string,
    displayName: string,
    companyName: string,
    reason: string,
  ): Promise<void> {
    await this.send(
      to,
      emailTemplates.companySuspended(displayName, companyName, reason),
    );
  }

  /**
   * Low-level send, exposed for modules that render their own RenderedEmail
   * (demo requests). Never throws: a mail failure must not break the caller.
   */
  async sendRendered(to: string, email: RenderedEmail): Promise<void> {
    await this.send(to, email);
  }

  private async send(to: string, email: RenderedEmail): Promise<void> {
    const from = this.config.get<string>('mail.from');
    if (!this.transport) {
      // Dev/console transport — surface everything needed to test the flow.
      this.logger.log(
        `\n──────── [DEV EMAIL] ────────\nTo: ${to}\nFrom: ${from}\nSubject: ${email.subject}\n\n${email.text}` +
          (email.attachments?.length
            ? `\n\nAttachments: ${email.attachments.map((a) => a.filename).join(', ')}`
            : '') +
          `\n─────────────────────────────`,
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
        ...(email.attachments?.length
          ? {
              attachments: email.attachments.map((a) => ({
                filename: a.filename,
                content: a.content,
                contentType: a.contentType,
              })),
            }
          : {}),
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
      this.logger.error(
        `Failed to send email to ${to}: ${(err as Error).message}`,
      );
    }
  }
}
