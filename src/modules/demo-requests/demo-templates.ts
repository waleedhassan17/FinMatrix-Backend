import {
  button,
  dateTimePk,
  esc,
  layout,
  type RenderedEmail,
} from '../mail/mail.layout';

/**
 * Demo booking emails, in English. Times are shown in Asia/Karachi.
 */

const link = (href: string | null | undefined, label: string) =>
  href ? `<p style="margin:20px 0;">${button(esc(href), label)}</p>` : '';

export interface DemoMailPerson {
  fullName: string;
  businessName: string;
}

export const demoTemplates = {
  confirmation(p: DemoMailPerson, preferredAt: Date): RenderedEmail {
    return {
      subject: 'We received your FinMatrix demo request',
      html: layout(
        'Your demo request is in',
        `<p>Hi ${esc(p.fullName)},</p>
         <p>Thanks for booking a FinMatrix demo for <strong>${esc(p.businessName)}</strong>. You asked for <strong>${dateTimePk(preferredAt)}</strong> (Pakistan time).</p>
         <p>Our team will confirm the time with you by phone, WhatsApp or email, usually within one business day, and send a calendar invite with the meeting link.</p>`,
      ),
      text:
        `Hi ${p.fullName},\n\nThanks for booking a FinMatrix demo for ${p.businessName}. ` +
        `You asked for ${dateTimePk(preferredAt)} (Pakistan time). Our team will confirm the time ` +
        `and send a calendar invite.`,
    };
  },

  adminNotice(input: {
    fullName: string;
    businessName: string;
    phone: string;
    email: string;
    city: string;
    businessType: string;
    teamSize: string | null;
    currentSystem: string | null;
    preferredAt: Date;
    message: string | null;
  }): RenderedEmail {
    return {
      subject: `New demo request: ${input.businessName} (${input.city})`,
      html: layout(
        'A new demo request',
        `<p><strong>${esc(input.businessName)}</strong> — ${esc(input.fullName)}<br/>
          ${esc(input.phone)} · ${esc(input.email)}<br/>
          ${esc(input.city)} · ${esc(input.businessType)}${
            input.teamSize ? ` · team ${esc(input.teamSize)}` : ''
          }<br/>
          Current system: ${esc(input.currentSystem ?? '—')}</p>
         <p><strong>Preferred time:</strong> ${dateTimePk(input.preferredAt)} PKT</p>
         ${input.message ? `<p><strong>Message:</strong><br/>${esc(input.message)}</p>` : ''}
         <p>Open <strong>Demo requests</strong> in the admin console to contact and schedule.</p>`,
      ),
      text:
        `New demo request\n\n${input.businessName} — ${input.fullName}\n${input.phone} · ${input.email}\n` +
        `${input.city} · ${input.businessType}\nPreferred: ${dateTimePk(input.preferredAt)} PKT` +
        (input.message ? `\n\nMessage: ${input.message}` : ''),
    };
  },

  scheduled(
    p: DemoMailPerson,
    at: Date,
    meetingLink: string | null,
    rescheduled: boolean,
  ): RenderedEmail {
    return {
      subject: rescheduled
        ? 'Your FinMatrix demo has a new time'
        : 'Your FinMatrix demo is booked',
      html: layout(
        'Your demo time',
        `<p>Hi ${esc(p.fullName)},</p>
         <p>Your FinMatrix demo is ${rescheduled ? '<strong>moved to</strong>' : 'booked for'} <strong>${dateTimePk(at)}</strong> (Pakistan time).</p>
         ${meetingLink ? `<p>Join here: <a href="${esc(meetingLink)}">${esc(meetingLink)}</a></p>` : ''}
         <p>The calendar invite is attached — open it to add the demo to your calendar.</p>` +
          link(meetingLink, 'Join the demo'),
      ),
      text:
        `Hi ${p.fullName},\n\nYour FinMatrix demo is ${rescheduled ? 'moved to' : 'booked for'} ` +
        `${dateTimePk(at)} (Pakistan time).` +
        (meetingLink ? `\nJoin: ${meetingLink}` : '') +
        `\n\nThe calendar invite is attached.`,
    };
  },

  cancelled(p: DemoMailPerson, at: Date | null): RenderedEmail {
    const when = at ? ` on ${dateTimePk(at)}` : '';
    return {
      subject: 'Your FinMatrix demo was cancelled',
      html: layout(
        'Demo cancelled',
        `<p>Hi ${esc(p.fullName)},</p>
         <p>Your FinMatrix demo${when} has been cancelled. If you'd still like one, reply to this email or book a new time on our website.</p>`,
      ),
      text: `Hi ${p.fullName},\n\nYour FinMatrix demo${when} has been cancelled. Reply to book a new time.`,
    };
  },

  reminder(
    p: DemoMailPerson,
    at: Date,
    meetingLink: string | null,
  ): RenderedEmail {
    return {
      subject: 'Reminder: your FinMatrix demo is coming up',
      html: layout(
        'Demo reminder',
        `<p>Hi ${esc(p.fullName)},</p>
         <p>A reminder: your FinMatrix demo starts at <strong>${dateTimePk(at)}</strong> (Pakistan time).</p>
         ${meetingLink ? `<p>Join here: <a href="${esc(meetingLink)}">${esc(meetingLink)}</a></p>` : ''}` +
          link(meetingLink, 'Join the demo'),
      ),
      text:
        `Hi ${p.fullName},\n\nReminder: your FinMatrix demo starts at ${dateTimePk(at)} (Pakistan time).` +
        (meetingLink ? `\nJoin: ${meetingLink}` : ''),
    };
  },

  /**
   * "Start your free trial" after a demo. `trialEligible` false (the email or
   * phone has already had a trial) offers account approval instead — the
   * invite never bypasses the one-trial rule.
   */
  trialInvite(
    p: DemoMailPerson,
    signupUrl: string,
    trialEligible: boolean,
  ): RenderedEmail {
    const body = trialEligible
      ? `<p>Hi ${esc(p.fullName)},</p>
         <p>Thanks for your time on the FinMatrix demo. Your free trial is one step away — sign up with the link below (your details are filled in) and it starts straight away.</p>`
      : `<p>Hi ${esc(p.fullName)},</p>
         <p>Thanks for your time on the FinMatrix demo. Sign up with the link below (your details are filled in), then choose <strong>Request account approval</strong> — our team will switch your plan on. (This email or phone number has already used a free trial.)</p>`;
    return {
      subject: trialEligible
        ? 'Start your FinMatrix free trial'
        : 'Set up your FinMatrix account',
      html: layout(
        'Get started with FinMatrix',
        body +
          link(
            signupUrl,
            trialEligible ? 'Start my free trial' : 'Create my account',
          ),
      ),
      text:
        `Hi ${p.fullName},\n\nThanks for your time on the FinMatrix demo. ` +
        (trialEligible
          ? 'Sign up and your free trial starts straight away:'
          : 'Sign up and choose "Request account approval":') +
        `\n${signupUrl}`,
    };
  },
};
