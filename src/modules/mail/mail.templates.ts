/**
 * Plain, dependency-free HTML email templates for Stage 1.
 * Kept inline (no templating engine) to avoid new dependencies.
 */

import { BRAND, button, esc, layout, type RenderedEmail } from './mail.layout';
import { launchEmailTemplates } from './launch-templates';

export type { RenderedEmail } from './mail.layout';

/**
 * The end-of-day digest, already formatted: the reports module decides what
 * the numbers are, this file only lays them out.
 */
export interface DaySummaryEmailInput {
  companyName: string;
  /** "Wed 19 Nov 2026". */
  dayLabel: string;
  /** Headline figures, e.g. { label: 'Sales', value: 'Rs 245,000', note: '12 invoices · +8% vs yesterday' }. */
  rows: Array<{ label: string; value: string; note?: string }>;
  topCustomers: Array<{ name: string; value: string }>;
  /** Lines worth a look, e.g. "2 entries back-dated". Empty when none. */
  attention: string[];
  /** Nothing at all was recorded that day. */
  quiet: boolean;
  /** Opens that day's Day Summary. */
  link: string;
}

export const emailTemplates = {
  /**
   * One link, over https, to the web app's verify page: it opens in every mail
   * client and carries the owner on into company setup.
   *
   * There used to be a second, `finmatrix://` link to open the Android app.
   * Links with a custom scheme are a phishing signal to spam filters, and the
   * app does not need one: its verify screen notices on its own when the
   * address has been confirmed, wherever the link was opened.
   */
  verification(displayName: string, appLink: string): RenderedEmail {
    const name = esc(displayName);
    const link = esc(appLink);
    return {
      subject: 'Verify your FinMatrix email',
      html: layout(
        'Confirm your email address',
        `<p>Hi ${name},</p>
         <p>Thanks for signing up for FinMatrix. Confirm your email address and we will take you straight on to setting up your company.</p>
         <p style="margin:24px 0;">${button(link, 'Verify email')}</p>
         <p style="font-size:13px;color:#6b7280;">Button not working? Copy this link into your browser:<br/>
         <a href="${link}">${link}</a></p>
         <p style="font-size:13px;color:#6b7280;">The link expires in 24 hours. If you did not sign up for FinMatrix, you can ignore this email.</p>`,
      ),
      text: `Hi ${displayName},\n\nConfirm your FinMatrix email address:\n${appLink}\n\nThe link expires in 24 hours. If you did not sign up for FinMatrix, you can ignore this email.`,
    };
  },

  otp(displayName: string, otp: string, ttlMinutes: number): RenderedEmail {
    return {
      subject: 'Your FinMatrix password reset code',
      html: layout(
        'Password reset code',
        `<p>Hi ${esc(displayName)},</p>
         <p>Use the following one-time code to reset your password. It expires in ${ttlMinutes} minutes.</p>
         <p style="font-size:30px;letter-spacing:8px;font-weight:700;margin:24px 0;color:${BRAND};">${otp}</p>
         <p style="font-size:13px;color:#6b7280;">If you didn't request this, you can safely ignore this email.</p>`,
      ),
      text: `Hi ${displayName},\n\nYour FinMatrix password reset code is: ${otp}\nIt expires in ${ttlMinutes} minutes.\n\nIf you didn't request this, ignore this email.`,
    };
  },

  companySubmitted(
    companyName: string,
    ownerEmail: string,
    requestedPlan: string | null = null,
    note: string | null = null,
  ): RenderedEmail {
    return {
      subject: `Account approval requested: ${companyName}`,
      html: layout(
        'A company asked for account approval',
        `<p>A company has asked for its account to be approved (sign-up path B — no free trial).</p>
         <p><strong>Company:</strong> ${esc(companyName)}<br/>
         <strong>Owner:</strong> ${esc(ownerEmail)}${
           requestedPlan
             ? `<br/><strong>Requested plan:</strong> ${esc(requestedPlan)}`
             : ''
         }</p>
         ${note ? `<p><strong>Note:</strong><br/>${esc(note)}</p>` : ''}
         <p>Open <strong>Trials &amp; approvals → Approval requests</strong> in the FinMatrix admin console to approve it with a plan, a start date and an end date, or reject it with a reason.</p>`,
      ),
      text:
        `A company asked for account approval.\n\nCompany: ${companyName}\nOwner: ${ownerEmail}` +
        (requestedPlan ? `\nRequested plan: ${requestedPlan}` : '') +
        (note ? `\nNote: ${note}` : '') +
        `\n\nAdmin console → Trials & approvals → Approval requests.`,
    };
  },

  approved(
    displayName: string,
    companyName: string,
    appUrl?: string,
  ): RenderedEmail {
    const open = appUrl ? `${appUrl}/dashboard` : '';
    return {
      subject: `${companyName} has been approved 🎉`,
      html: layout(
        'Your company has been approved',
        `<p>Hi ${esc(displayName)},</p>
         <p>Good news — <strong>${esc(companyName)}</strong> has been approved. You now have full access to FinMatrix.</p>
         ${open ? `<p style="margin:24px 0;">${button(open, 'Open FinMatrix')}</p>` : '<p>Sign in to get started.</p>'}
         <p style="font-size:13px;color:#6b7280;">Already have FinMatrix open? It moves on by itself — no need to sign in again.</p>`,
      ),
      text: `Hi ${displayName},\n\n${companyName} has been approved. You now have full access to FinMatrix.${open ? `\n\nOpen FinMatrix: ${open}` : ' Sign in to get started.'}`,
    };
  },

  /** Access paused by a FinMatrix administrator. Nothing is deleted. */
  deactivated(displayName: string, companyName: string): RenderedEmail {
    return {
      subject: `${companyName}: access paused`,
      html: layout(
        'Your company account has been deactivated',
        `<p>Hi ${esc(displayName)},</p>
         <p>Access to <strong>${esc(companyName)}</strong> on FinMatrix has been paused by our team, so you and your team cannot sign in for now.</p>
         <p>Your data is safe and untouched. Reply to your FinMatrix contact to restore access.</p>`,
      ),
      text: `Hi ${displayName},\n\nAccess to ${companyName} on FinMatrix has been paused by our team, so you and your team cannot sign in for now.\n\nYour data is safe and untouched. Reply to your FinMatrix contact to restore access.`,
    };
  },

  /** Access restored after a deactivation. */
  reactivated(
    displayName: string,
    companyName: string,
    appUrl?: string,
  ): RenderedEmail {
    const open = appUrl ? `${appUrl}/dashboard` : '';
    return {
      subject: `${companyName} is active again`,
      html: layout(
        'Your company account is active again',
        `<p>Hi ${esc(displayName)},</p>
         <p><strong>${esc(companyName)}</strong> has been reactivated. You and your team can sign in and pick up where you left off.</p>
         ${open ? `<p style="margin:24px 0;">${button(open, 'Open FinMatrix')}</p>` : ''}`,
      ),
      text: `Hi ${displayName},\n\n${companyName} has been reactivated. You and your team can sign in and pick up where you left off.${open ? `\n\nOpen FinMatrix: ${open}` : ''}`,
    };
  },

  rejected(
    displayName: string,
    companyName: string,
    reason: string,
  ): RenderedEmail {
    return {
      subject: `Update on your FinMatrix registration`,
      html: layout(
        'Your company registration was not approved',
        `<p>Hi ${esc(displayName)},</p>
         <p>Unfortunately <strong>${esc(companyName)}</strong> was not approved at this time.</p>
         <p><strong>Reason:</strong><br/>${esc(reason)}</p>
         <p>You can update your details and resubmit for review from the app.</p>`,
      ),
      text: `Hi ${displayName},\n\n${companyName} was not approved.\n\nReason: ${reason}\n\nYou can update your details and resubmit from the app.`,
    };
  },

  // Free trial, activation, suspension and demo emails: launch-templates.ts
  // (bilingual English + Urdu).
  ...launchEmailTemplates,

  daySummary(input: DaySummaryEmailInput): RenderedEmail {
    const title = `${input.companyName}: ${input.dayLabel}`;
    const rowsHtml = input.rows
      .map(
        (r) => `<tr>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;color:#4b5563;">${esc(r.label)}${
            r.note
              ? `<div style="font-size:12px;color:#6b7280;margin-top:2px;">${esc(r.note)}</div>`
              : ''
          }</td>
          <td style="padding:10px 0;border-bottom:1px solid #e5e7eb;text-align:right;font-weight:600;white-space:nowrap;">${esc(r.value)}</td>
        </tr>`,
      )
      .join('');
    const customersHtml = input.topCustomers.length
      ? `<p style="margin:20px 0 6px;font-weight:600;">Top customers</p>
         <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">${input.topCustomers
           .map(
             (c) => `<tr>
               <td style="padding:6px 0;color:#4b5563;">${esc(c.name)}</td>
               <td style="padding:6px 0;text-align:right;white-space:nowrap;">${esc(c.value)}</td>
             </tr>`,
           )
           .join('')}</table>`
      : '';
    const attentionHtml = input.attention.length
      ? `<div style="margin:20px 0 0;padding:12px 14px;background:#fffbeb;border:1px solid #fde68a;border-radius:8px;font-size:14px;">
           <strong>Worth a look</strong>
           <ul style="margin:6px 0 0;padding-left:18px;">${input.attention
             .map((a) => `<li>${esc(a)}</li>`)
             .join('')}</ul>
         </div>`
      : '';
    const body = input.quiet
      ? `<p>Nothing was recorded in FinMatrix on ${esc(input.dayLabel)}: no invoices, orders, receipts or bills.</p>
         <p>If the shop was open, entries may still be waiting to be made.</p>`
      : `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:14px;">${rowsHtml}</table>
         ${customersHtml}
         ${attentionHtml}`;
    const textRows = input.quiet
      ? [`Nothing was recorded on ${input.dayLabel}.`]
      : [
          ...input.rows.map(
            (r) => `${r.label}: ${r.value}${r.note ? ` (${r.note})` : ''}`,
          ),
          ...(input.topCustomers.length
            ? [
                '',
                'Top customers:',
                ...input.topCustomers.map((c) => `- ${c.name}: ${c.value}`),
              ]
            : []),
          ...(input.attention.length
            ? ['', 'Worth a look:', ...input.attention.map((a) => `- ${a}`)]
            : []),
        ];
    return {
      subject: `Day summary — ${input.companyName}, ${input.dayLabel}`,
      html: layout(
        title,
        `${body}
         <p style="margin:24px 0 0;">${button(input.link, 'Open the day summary')}</p>
         <p style="font-size:12px;color:#6b7280;margin:16px 0 0;">You get this because the daily summary is on for ${esc(input.companyName)}. An owner can turn it off on the Day Summary page.</p>`,
      ),
      text:
        `${title}\n\n${textRows.join('\n')}\n\nOpen the day summary: ${input.link}\n\n` +
        `You get this because the daily summary is on for ${input.companyName}. ` +
        `An owner can turn it off on the Day Summary page.`,
    };
  },
};
