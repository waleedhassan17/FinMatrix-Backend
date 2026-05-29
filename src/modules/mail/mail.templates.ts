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
};
