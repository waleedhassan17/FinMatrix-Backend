import {
  button,
  esc,
  layout,
  longDate,
  type RenderedEmail,
} from './mail.layout';

/**
 * Launch emails: free trial, activation (no payment gateway), approval with a
 * plan. English only.
 *
 * The copy matches what the product actually does: a trial normally starts
 * instantly; there is no online payment — the owner asks for activation and
 * the FinMatrix team switches the plan on; and data is never deleted when a
 * trial or plan ends.
 */

function days(n: number): string {
  return `${n} day${n === 1 ? '' : 's'}`;
}

/** Optional button + a plain-text line for the same link. */
function cta(href: string | undefined, label: string): string {
  return href
    ? `<p style="margin:24px 0;">${button(esc(href), label)}</p>`
    : '';
}

export interface TrialEmailLinks {
  /** The customer web app root, e.g. https://app.example.com */
  app?: string;
  /** The Migration Center guide page. */
  migrationGuide?: string;
}

export const launchEmailTemplates = {
  // ── Free trial ──────────────────────────────────────────────────────────

  /**
   * The trial request is held for a person to review (a risk signal, or
   * TRIAL_AUTO_APPROVE=false). Never says why.
   */
  trialRequested(displayName: string, companyName: string): RenderedEmail {
    return {
      subject: "We're reviewing your FinMatrix free trial",
      html: layout(
        "We're reviewing your free trial",
        `<p>Hi ${esc(displayName)},</p>
         <p>Thanks for choosing FinMatrix for <strong>${esc(companyName)}</strong>. Our team is reviewing your free trial — usually within a few hours.</p>
         <p>Your trial days start when it is switched on, so no time is lost while you wait. We'll email you as soon as it's live.</p>`,
      ),
      text:
        `Hi ${displayName},\n\nThanks for choosing FinMatrix for ${companyName}. Our team is reviewing ` +
        `your free trial — usually within a few hours.\n\nYour trial days start when it is switched on. ` +
        `We'll email you as soon as it's live.`,
    };
  },

  /** To the platform admin: a trial is waiting for a decision. */
  trialRequestedAdmin(
    companyName: string,
    ownerEmail: string,
    ownerPhone: string | null,
    holdReason: string | null,
  ): RenderedEmail {
    const why = holdReason
      ? `It was held for review: ${holdReason}`
      : 'Automatic approval is switched off (TRIAL_AUTO_APPROVE=false).';
    return {
      subject: `Free trial waiting for review: ${companyName}`,
      html: layout(
        'A free trial needs review',
        `<p>A free trial request is waiting for a decision. ${esc(why)}</p>
         <p><strong>Company:</strong> ${esc(companyName)}<br/>
         <strong>Owner:</strong> ${esc(ownerEmail)}<br/>
         <strong>Phone:</strong> ${esc(ownerPhone ?? '—')}</p>
         <p>Open <strong>Trials &amp; approvals → Held for review</strong> in the FinMatrix admin console to approve or reject it. The owner was told "usually within a few hours".</p>`,
      ),
      text:
        `A free trial request is waiting for a decision. ${why}\n\n` +
        `Company: ${companyName}\nOwner: ${ownerEmail}\nPhone: ${ownerPhone ?? '—'}\n\n` +
        `Admin console → Trials & approvals → Held for review.`,
    };
  },

  /** FYI to the platform admin: a trial started on its own. No action needed. */
  trialAutoApprovedAdmin(
    companyName: string,
    ownerEmail: string,
    ownerPhone: string | null,
    trialEndsAt: Date,
  ): RenderedEmail {
    const ends = longDate(trialEndsAt);
    return {
      subject: `New free trial started: ${companyName}`,
      html: layout(
        'A free trial started (no action needed)',
        `<p>A company passed every eligibility check and its free trial started automatically.</p>
         <p><strong>Company:</strong> ${esc(companyName)}<br/>
         <strong>Owner:</strong> ${esc(ownerEmail)}<br/>
         <strong>Phone:</strong> ${esc(ownerPhone ?? '—')}<br/>
         <strong>Trial ends:</strong> ${ends}</p>
         <p>It appears under <strong>Trials &amp; approvals → Active trials</strong> with an "Auto-approved" badge. You can end it early there if it looks like abuse.</p>`,
      ),
      text:
        `A free trial started automatically (no action needed).\n\n` +
        `Company: ${companyName}\nOwner: ${ownerEmail}\nPhone: ${ownerPhone ?? '—'}\nTrial ends: ${ends}`,
    };
  },

  trialApproved(
    displayName: string,
    companyName: string,
    trialEndsAt: Date,
    links: TrialEmailLinks = {},
  ): RenderedEmail {
    const ends = longDate(trialEndsAt);
    const open = links.app ? `${links.app}/dashboard` : undefined;
    return {
      subject: 'Your FinMatrix free trial has started',
      html: layout(
        'Your free trial has started',
        `<p>Hi ${esc(displayName)},</p>
         <p><strong>${esc(companyName)}</strong> now has the full FinMatrix Warehouse system — accounting, inventory, sales, purchasing and deliveries (one delivery rider during the trial).</p>
         <p><strong>Your trial ends on ${ends}.</strong></p>
         ${cta(open, 'Open FinMatrix')}
         <p><strong>Moving from another system?</strong> Bring your opening balances, customers, suppliers and stock in with the Migration Center — Tally, Peachtree/Sage 50, QuickBooks, Xero, Zoho or a spreadsheet.${
           links.migrationGuide
             ? ` <a href="${esc(links.migrationGuide)}">Move your data in</a>.`
             : ''
         }</p>
         <p>When you're ready to continue, press <strong>Request activation</strong> in FinMatrix and our team will switch your plan on — there is no online payment. If the trial ends first, your account pauses and your data is kept safe; nothing is deleted.</p>`,
      ),
      text:
        `Hi ${displayName},\n\n${companyName} now has the full FinMatrix Warehouse system (one delivery ` +
        `rider during the trial).\n\nYour trial ends on ${ends}.\n` +
        (open ? `\nOpen FinMatrix: ${open}\n` : '') +
        (links.migrationGuide
          ? `\nMove your data in from your old system: ${links.migrationGuide}\n`
          : '') +
        `\nWhen you're ready to continue, press "Request activation" in FinMatrix and our team will ` +
        `switch your plan on — there is no online payment. If the trial ends first, your data is kept safe.`,
    };
  },

  trialRejected(
    displayName: string,
    companyName: string,
    reason: string,
  ): RenderedEmail {
    return {
      subject: 'Update on your FinMatrix free trial',
      html: layout(
        'We could not start a free trial',
        `<p>Hi ${esc(displayName)},</p>
         <p>We reviewed the free trial for <strong>${esc(companyName)}</strong> and could not start it this time.</p>
         <p><strong>Note from our team:</strong><br/>${esc(reason)}</p>
         <p>Your company setup is saved. You can still <strong>request account approval</strong> from the sign-in screen, or book a demo and we'll set things up with you.</p>`,
      ),
      text:
        `Hi ${displayName},\n\nWe could not start the free trial for ${companyName} this time.\n\n` +
        `Note from our team: ${reason}\n\nYour company setup is saved. You can still request account ` +
        `approval, or book a demo.`,
    };
  },

  trialEnding(
    displayName: string,
    companyName: string,
    daysRemaining: number,
    appUrl?: string,
  ): RenderedEmail {
    const d = days(daysRemaining);
    return {
      subject: `Your FinMatrix trial ends in ${d}`,
      html: layout(
        `Your free trial ends in ${d}`,
        `<p>Hi ${esc(displayName)},</p>
         <p>The free trial for <strong>${esc(companyName)}</strong> ends in <strong>${d}</strong>.</p>
         <p>To keep going without a break, press <strong>Request activation</strong> in FinMatrix (Settings, or the trial banner). Our team agrees a plan with you and switches it on — there is no online payment.</p>
         ${cta(appUrl, 'Open FinMatrix')}
         <p>If the trial ends first, your data is kept safe — you can still sign in, download a full backup and request activation.</p>`,
      ),
      text:
        `Hi ${displayName},\n\nThe free trial for ${companyName} ends in ${d}.\n\nPress "Request ` +
        `activation" in FinMatrix and our team will switch your plan on — there is no online payment.` +
        (appUrl ? `\n\nOpen FinMatrix: ${appUrl}` : '') +
        `\n\nIf the trial ends first, your data is kept safe.`,
    };
  },

  trialEnded(
    displayName: string,
    companyName: string,
    appUrl?: string,
  ): RenderedEmail {
    return {
      subject: 'Your FinMatrix trial has ended — your data is safe',
      html: layout(
        'Your trial has ended',
        `<p>Hi ${esc(displayName)},</p>
         <p>The free trial for <strong>${esc(companyName)}</strong> has ended, so the account is paused.</p>
         <p><strong>Your data is safe. Nothing has been deleted.</strong> You can still sign in, download a full backup of your company, and press <strong>Request activation</strong> — our team switches your plan on and everything is exactly as you left it.</p>
         ${cta(appUrl, 'Sign in to FinMatrix')}`,
      ),
      text:
        `Hi ${displayName},\n\nThe free trial for ${companyName} has ended, so the account is paused.\n\n` +
        `Your data is safe. Sign in to download a full backup or press "Request activation".` +
        (appUrl ? `\n\n${appUrl}` : ''),
    };
  },

  trialEndedEarly(
    displayName: string,
    companyName: string,
    reason: string,
  ): RenderedEmail {
    return {
      subject: 'Your FinMatrix trial has been ended',
      html: layout(
        'Your free trial has been ended',
        `<p>Hi ${esc(displayName)},</p>
         <p>The FinMatrix team has ended the free trial for <strong>${esc(companyName)}</strong>.</p>
         <p><strong>Reason:</strong><br/>${esc(reason)}</p>
         <p>Your data is kept safe. You can sign in to download a backup, or contact us to discuss activating a plan.</p>`,
      ),
      text:
        `Hi ${displayName},\n\nThe FinMatrix team has ended the free trial for ${companyName}.\n\n` +
        `Reason: ${reason}\n\nYour data is kept safe. You can sign in to download a backup.`,
    };
  },

  trialExtended(
    displayName: string,
    companyName: string,
    newEnd: Date,
    extraDays: number,
  ): RenderedEmail {
    const ends = longDate(newEnd);
    return {
      subject: `Your FinMatrix trial has been extended by ${days(extraDays)}`,
      html: layout(
        'Your free trial has been extended',
        `<p>Hi ${esc(displayName)},</p>
         <p>Good news — the FinMatrix team has extended the free trial for <strong>${esc(companyName)}</strong> by <strong>${days(extraDays)}</strong>.</p>
         <p><strong>Your trial now ends on ${ends}.</strong></p>`,
      ),
      text:
        `Hi ${displayName},\n\nThe free trial for ${companyName} has been extended by ${days(extraDays)}. ` +
        `It now ends on ${ends}.`,
    };
  },

  // ── Activation (no payment gateway) ─────────────────────────────────────

  activationRequested(displayName: string, companyName: string): RenderedEmail {
    return {
      subject: "We've received your activation request",
      html: layout(
        "We've received your activation request",
        `<p>Hi ${esc(displayName)},</p>
         <p>Thanks — we've received the request to activate a plan for <strong>${esc(companyName)}</strong>. Our team will contact you to confirm the plan and switch it on, usually within one business day.</p>`,
      ),
      text:
        `Hi ${displayName},\n\nWe've received the request to activate a plan for ${companyName}. Our ` +
        `team will contact you to confirm the plan and switch it on, usually within one business day.`,
    };
  },

  activationRequestedAdmin(
    companyName: string,
    ownerEmail: string,
    requestedPlan: string,
    note: string | null,
  ): RenderedEmail {
    return {
      subject: `Activation requested: ${companyName}`,
      html: layout(
        'An activation request needs review',
        `<p>An owner has asked for a plan to be switched on.</p>
         <p><strong>Company:</strong> ${esc(companyName)}<br/>
         <strong>Owner:</strong> ${esc(ownerEmail)}<br/>
         <strong>Requested plan:</strong> ${esc(requestedPlan)}</p>
         ${note ? `<p><strong>Note:</strong><br/>${esc(note)}</p>` : ''}
         <p>Open <strong>Trials &amp; approvals → Activation requests</strong> in the admin console to approve it with a plan, start and end date.</p>`,
      ),
      text:
        `Activation requested.\n\nCompany: ${companyName}\nOwner: ${ownerEmail}\n` +
        `Requested plan: ${requestedPlan}` +
        (note ? `\nNote: ${note}` : '') +
        `\n\nAdmin console → Trials & approvals → Activation requests.`,
    };
  },

  /** A plan was switched on (activation request, or path-B approval). */
  planActivated(
    displayName: string,
    companyName: string,
    planLabel: string,
    endsAt: Date,
    appUrl?: string,
  ): RenderedEmail {
    const ends = longDate(endsAt);
    const open = appUrl ? `${appUrl}/dashboard` : undefined;
    return {
      subject: `${companyName} is active on FinMatrix`,
      html: layout(
        'Your FinMatrix plan is active',
        `<p>Hi ${esc(displayName)},</p>
         <p><strong>${esc(companyName)}</strong> is active on the <strong>${esc(planLabel)}</strong> plan until <strong>${ends}</strong>. Every record you entered is exactly where you left it.</p>
         ${cta(open, 'Open FinMatrix')}`,
      ),
      text:
        `Hi ${displayName},\n\n${companyName} is active on the ${planLabel} plan until ${ends}.` +
        (open ? `\n\nOpen FinMatrix: ${open}` : ''),
    };
  },

  activationRejected(
    displayName: string,
    companyName: string,
    reason: string,
  ): RenderedEmail {
    return {
      subject: 'Update on your FinMatrix activation request',
      html: layout(
        'We could not activate a plan yet',
        `<p>Hi ${esc(displayName)},</p>
         <p>We could not activate a plan for <strong>${esc(companyName)}</strong> yet.</p>
         <p><strong>Note from our team:</strong><br/>${esc(reason)}</p>
         <p>Your data is safe. Reply to this email or contact support and we'll sort it out with you.</p>`,
      ),
      text:
        `Hi ${displayName},\n\nWe could not activate a plan for ${companyName} yet.\n\n` +
        `Note from our team: ${reason}\n\nYour data is safe.`,
    };
  },

  // ── Suspension (super-admin) ────────────────────────────────────────────

  accountSuspended(displayName: string, reason: string): RenderedEmail {
    return {
      subject: 'Your FinMatrix account has been suspended',
      html: layout(
        'Your account has been suspended',
        `<p>Hi ${esc(displayName)},</p>
         <p>Your FinMatrix account has been suspended by our team, so it cannot be used to sign in for now.</p>
         <p><strong>Reason:</strong><br/>${esc(reason)}</p>
         <p>If you think this is a mistake, reply to this email or contact support.</p>`,
      ),
      text:
        `Hi ${displayName},\n\nYour FinMatrix account has been suspended by our team.\n\n` +
        `Reason: ${reason}\n\nIf you think this is a mistake, contact support.`,
    };
  },

  accountReinstated(displayName: string, appUrl?: string): RenderedEmail {
    return {
      subject: 'Your FinMatrix account is active again',
      html: layout(
        'Your account is active again',
        `<p>Hi ${esc(displayName)},</p>
         <p>Your FinMatrix account has been reinstated. You can sign in again.</p>
         ${cta(appUrl, 'Sign in to FinMatrix')}`,
      ),
      text: `Hi ${displayName},\n\nYour FinMatrix account has been reinstated. You can sign in again.`,
    };
  },

  companySuspended(
    displayName: string,
    companyName: string,
    reason: string,
  ): RenderedEmail {
    return {
      subject: `${companyName}: account suspended`,
      html: layout(
        'Your company account has been suspended',
        `<p>Hi ${esc(displayName)},</p>
         <p>Access to <strong>${esc(companyName)}</strong> on FinMatrix has been suspended by our team, so you and your team cannot use it for now.</p>
         <p><strong>Reason:</strong><br/>${esc(reason)}</p>
         <p>Your data is safe and untouched. Reply to this email or contact support to restore access.</p>`,
      ),
      text:
        `Hi ${displayName},\n\nAccess to ${companyName} on FinMatrix has been suspended by our team.\n\n` +
        `Reason: ${reason}\n\nYour data is safe. Contact support to restore access.`,
    };
  },
};
