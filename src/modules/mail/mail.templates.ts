/**
 * Plain, dependency-free HTML email templates for Stage 1.
 * Kept inline (no templating engine) to avoid new dependencies.
 */

const BRAND = '#1f6feb';

function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
      <div style="background:${BRAND};padding:20px 28px;">
        <span style="color:#ffffff;font-size:20px;font-weight:700;">FinMatrix</span>
      </div>
      <div style="padding:28px;">
        <h2 style="margin:0 0 16px;font-size:18px;">${title}</h2>
        ${bodyHtml}
      </div>
      <div style="padding:16px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
        This is an automated message from FinMatrix. Please do not reply.
      </div>
    </div>
  </body>
</html>`;
}

function button(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">${label}</a>`;
}

/**
 * HTML-escape a value interpolated into a template. Used by the trial templates,
 * which carry free text a person typed (a rejection reason, a company name).
 */
function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "15 October 2026" — unambiguous in Pakistan, unlike 10/15/2026. */
function longDate(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Karachi',
  });
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export const emailTemplates = {
  verification(displayName: string, deepLink: string, webLink: string): RenderedEmail {
    return {
      subject: 'Verify your FinMatrix email',
      html: layout(
        'Confirm your email address',
        `<p>Hi ${displayName},</p>
         <p>Thanks for signing up for FinMatrix. Tap the button below to verify your email and continue setting up your company.</p>
         <p style="margin:24px 0;">${button(deepLink, 'Verify email')}</p>
         <p style="font-size:13px;color:#6b7280;">If the button doesn't open the app, use this link instead:<br/>
         <a href="${webLink}">${webLink}</a></p>
         <p style="font-size:13px;color:#6b7280;">This link expires soon and can only be used once.</p>`,
      ),
      text: `Hi ${displayName},\n\nVerify your FinMatrix email:\n${deepLink}\n\nIf the app link doesn't work, open: ${webLink}\n\nThis link expires soon and can only be used once.`,
    };
  },

  otp(displayName: string, otp: string, ttlMinutes: number): RenderedEmail {
    return {
      subject: 'Your FinMatrix password reset code',
      html: layout(
        'Password reset code',
        `<p>Hi ${displayName},</p>
         <p>Use the following one-time code to reset your password. It expires in ${ttlMinutes} minutes.</p>
         <p style="font-size:30px;letter-spacing:8px;font-weight:700;margin:24px 0;color:${BRAND};">${otp}</p>
         <p style="font-size:13px;color:#6b7280;">If you didn't request this, you can safely ignore this email.</p>`,
      ),
      text: `Hi ${displayName},\n\nYour FinMatrix password reset code is: ${otp}\nIt expires in ${ttlMinutes} minutes.\n\nIf you didn't request this, ignore this email.`,
    };
  },

  companySubmitted(companyName: string, ownerEmail: string): RenderedEmail {
    return {
      subject: `New company awaiting approval: ${companyName}`,
      html: layout(
        'A company registration needs review',
        `<p>A new company has completed onboarding and is awaiting your approval.</p>
         <p><strong>Company:</strong> ${companyName}<br/>
         <strong>Owner:</strong> ${ownerEmail}</p>
         <p>Open the FinMatrix admin console to review and approve or reject this registration.</p>`,
      ),
      text: `A new company is awaiting approval.\n\nCompany: ${companyName}\nOwner: ${ownerEmail}\n\nOpen the FinMatrix admin console to review it.`,
    };
  },

  approved(displayName: string, companyName: string): RenderedEmail {
    return {
      subject: `${companyName} has been approved 🎉`,
      html: layout(
        'Your company has been approved',
        `<p>Hi ${displayName},</p>
         <p>Good news — <strong>${companyName}</strong> has been approved. You now have full access to FinMatrix.</p>
         <p>Sign in to get started.</p>`,
      ),
      text: `Hi ${displayName},\n\n${companyName} has been approved. You now have full access to FinMatrix. Sign in to get started.`,
    };
  },

  rejected(displayName: string, companyName: string, reason: string): RenderedEmail {
    return {
      subject: `Update on your FinMatrix registration`,
      html: layout(
        'Your company registration was not approved',
        `<p>Hi ${displayName},</p>
         <p>Unfortunately <strong>${companyName}</strong> was not approved at this time.</p>
         <p><strong>Reason:</strong><br/>${reason}</p>
         <p>You can update your details and resubmit for review from the app.</p>`,
      ),
      text: `Hi ${displayName},\n\n${companyName} was not approved.\n\nReason: ${reason}\n\nYou can update your details and resubmit from the app.`,
    };
  },

  // ── Free trial ──────────────────────────────────────────────────────────
  // The copy never promises instant access: a trial is activated by a person,
  // and every line below says so.

  trialRequested(displayName: string, companyName: string): RenderedEmail {
    return {
      subject: "We've received your free trial request",
      html: layout(
        "We've received your free trial request",
        `<p>Hi ${esc(displayName)},</p>
         <p>Thanks for choosing FinMatrix for <strong>${esc(companyName)}</strong>. Our team reviews every trial request and activates it within <strong>24 hours</strong>.</p>
         <p>Your 30 days start when the trial is activated, so no time is lost while you wait. We'll email you as soon as it's live.</p>`,
      ),
      text:
        `Hi ${displayName},\n\nThanks for choosing FinMatrix for ${companyName}. Our team reviews every trial ` +
        `request and activates it within 24 hours.\n\nYour 30 days start when the trial is activated, so no ` +
        `time is lost while you wait. We'll email you as soon as it's live.`,
    };
  },

  trialRequestedAdmin(companyName: string, ownerEmail: string, ownerPhone: string | null): RenderedEmail {
    return {
      subject: `Free trial request awaiting review: ${companyName}`,
      html: layout(
        'A free trial request needs review',
        `<p>A company has asked for a 30-day free trial. The owner was told it will be activated within 24 hours.</p>
         <p><strong>Company:</strong> ${esc(companyName)}<br/>
         <strong>Owner:</strong> ${esc(ownerEmail)}<br/>
         <strong>Phone:</strong> ${esc(ownerPhone ?? '—')}</p>
         <p>Open Payment Verification in the FinMatrix admin console and filter by Trials to approve or reject it.</p>`,
      ),
      text:
        `A company has asked for a 30-day free trial (promised within 24 hours).\n\n` +
        `Company: ${companyName}\nOwner: ${ownerEmail}\nPhone: ${ownerPhone ?? '—'}\n\n` +
        `Open Payment Verification in the admin console and filter by Trials.`,
    };
  },

  trialApproved(displayName: string, companyName: string, trialEndsAt: Date): RenderedEmail {
    const ends = longDate(trialEndsAt);
    return {
      subject: 'Your 30-day FinMatrix trial is active',
      html: layout(
        'Your free trial is active',
        `<p>Hi ${esc(displayName)},</p>
         <p><strong>${esc(companyName)}</strong> now has full access to FinMatrix — every accounting, inventory and delivery feature, with one delivery rider.</p>
         <p><strong>Your trial ends on ${ends}.</strong></p>
         <p>Subscribe any time before then to add more riders and keep going without a break. If the trial ends first, your account pauses until you subscribe — your data is kept safe and nothing is deleted.</p>
         <p>Sign in to get started.</p>`,
      ),
      text:
        `Hi ${displayName},\n\n${companyName} now has full access to FinMatrix, with one delivery rider.\n\n` +
        `Your trial ends on ${ends}.\n\nSubscribe any time before then to add more riders and keep going ` +
        `without a break. If the trial ends first, your account pauses until you subscribe — your data is ` +
        `kept safe.\n\nSign in to get started.`,
    };
  },

  trialRejected(displayName: string, companyName: string, reason: string): RenderedEmail {
    return {
      subject: 'Update on your FinMatrix free trial request',
      html: layout(
        'We could not activate a free trial',
        `<p>Hi ${esc(displayName)},</p>
         <p>We reviewed the free trial request for <strong>${esc(companyName)}</strong> and were not able to activate it this time.</p>
         <p><strong>Note from our team:</strong><br/>${esc(reason)}</p>
         <p>Your company setup is saved. You can still start straight away with a paid plan: sign in, choose a plan, and pay by bank transfer — your account is activated once the transfer is verified.</p>`,
      ),
      text:
        `Hi ${displayName},\n\nWe reviewed the free trial request for ${companyName} and were not able to ` +
        `activate it this time.\n\nNote from our team: ${reason}\n\nYour company setup is saved. You can still ` +
        `start with a paid plan: sign in, choose a plan, and pay by bank transfer.`,
    };
  },

  trialEnding(displayName: string, companyName: string, daysRemaining: number): RenderedEmail {
    const days = `${daysRemaining} day${daysRemaining === 1 ? '' : 's'}`;
    return {
      subject: `Your FinMatrix trial ends in ${days}`,
      html: layout(
        `Your free trial ends in ${days}`,
        `<p>Hi ${esc(displayName)},</p>
         <p>The free trial for <strong>${esc(companyName)}</strong> ends in <strong>${days}</strong>.</p>
         <p>Subscribe now to keep everything running without a break. Choose a plan in the app or on the web, pay by bank transfer, and your subscription starts as soon as the transfer is verified.</p>
         <p>If the trial ends first, your data is kept safe — you just won't be able to use the books until you subscribe.</p>`,
      ),
      text:
        `Hi ${displayName},\n\nThe free trial for ${companyName} ends in ${days}.\n\nSubscribe now to keep ` +
        `everything running: choose a plan, pay by bank transfer, and your subscription starts once the ` +
        `transfer is verified.\n\nIf the trial ends first, your data is kept safe.`,
    };
  },

  trialEnded(displayName: string, companyName: string): RenderedEmail {
    return {
      subject: 'Your FinMatrix trial has ended',
      html: layout(
        'Your trial has ended — subscribe to keep access',
        `<p>Hi ${esc(displayName)},</p>
         <p>The free trial for <strong>${esc(companyName)}</strong> has ended, so the account is paused.</p>
         <p><strong>Your data is safe.</strong> Nothing has been deleted. Sign in, choose a plan and pay by bank transfer — everything switches back on once the transfer is verified.</p>`,
      ),
      text:
        `Hi ${displayName},\n\nThe free trial for ${companyName} has ended, so the account is paused.\n\n` +
        `Your data is safe. Sign in, choose a plan and pay by bank transfer — everything switches back on ` +
        `once the transfer is verified.`,
    };
  },
};
