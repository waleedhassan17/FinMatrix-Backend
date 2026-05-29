import { registerAs } from '@nestjs/config';

/**
 * Mail + deep-link configuration (Stage 1).
 *
 * `SMTP_PASS` is accepted as an alias for `SMTP_PASSWORD` so either name works.
 * When EMAIL_ENABLED is false the MailService falls back to a console/dev
 * transport so the verification / OTP / approval flows are fully testable
 * locally before real SMTP credentials are provided.
 */
export default registerAs('mail', () => ({
  enabled: (process.env.EMAIL_ENABLED ?? 'false') === 'true',
  host: process.env.SMTP_HOST ?? '',
  port: parseInt(process.env.SMTP_PORT ?? '587', 10),
  secure: (process.env.SMTP_SECURE ?? 'false') === 'true',
  user: process.env.SMTP_USER ?? '',
  pass: process.env.SMTP_PASSWORD ?? process.env.SMTP_PASS ?? '',
  from: process.env.SMTP_FROM ?? 'FinMatrix <no-reply@finmatrix.pk>',

  // Deep-link / web-fallback config for verification emails.
  appScheme: process.env.APP_DEEP_LINK_SCHEME ?? 'finmatrix',
  webFallbackBaseUrl:
    process.env.WEB_FALLBACK_URL ??
    `${process.env.APP_URL ?? 'http://localhost:3000'}/${process.env.API_PREFIX ?? 'api/v1'}/auth`,

  // Where "a new company is awaiting approval" notifications are sent.
  platformAdminEmail:
    process.env.ADMIN_EMAIL ?? process.env.SUPER_ADMIN_EMAIL ?? '',

  // OTP tuning.
  otpTtlMinutes: parseInt(process.env.OTP_TTL_MINUTES ?? '10', 10),
  otpMaxAttempts: parseInt(process.env.OTP_MAX_ATTEMPTS ?? '5', 10),
  // Verification token lifetime.
  verificationTtlHours: parseInt(process.env.VERIFICATION_TTL_HOURS ?? '24', 10),
}));
