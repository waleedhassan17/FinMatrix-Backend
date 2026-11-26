import {
  button,
  dateTimePk,
  dateTimePkUr,
  esc,
  layout,
  type RenderedEmail,
} from '../mail/mail.layout';

/**
 * Demo booking emails. A prospect's emails are in the language they chose on
 * the form (English or Urdu); the admin notice is English. Times are shown in
 * Asia/Karachi.
 */
type Lang = 'en' | 'ur';

function bodyFor(lang: Lang, en: string, ur: string): string {
  // Urdu prospects read Urdu first, with the English underneath for anyone
  // else on the thread; English prospects get English only.
  return lang === 'ur'
    ? `<div dir="rtl" lang="ur" style="font-family:'Noto Nastaliq Urdu','Jameel Noori Nastaleeq',Tahoma,sans-serif;font-size:15px;line-height:1.9;text-align:right;">${ur}</div>` +
        `<div style="margin-top:20px;padding-top:12px;border-top:1px solid #e5e7eb;font-size:13px;color:#6b7280;">${en}</div>`
    : en;
}

const link = (href: string | null | undefined, label: string) =>
  href ? `<p style="margin:20px 0;">${button(esc(href), label)}</p>` : '';

export interface DemoMailPerson {
  fullName: string;
  businessName: string;
  language: Lang;
}

export const demoTemplates = {
  confirmation(p: DemoMailPerson, preferredAt: Date): RenderedEmail {
    const en = `<p>Hi ${esc(p.fullName)},</p>
      <p>Thanks for booking a FinMatrix demo for <strong>${esc(p.businessName)}</strong>. You asked for <strong>${dateTimePk(preferredAt)}</strong> (Pakistan time).</p>
      <p>Our team will confirm the time with you by phone, WhatsApp or email, usually within one business day, and send a calendar invite with the meeting link.</p>`;
    const ur = `<p>${esc(p.fullName)} صاحب/صاحبہ،</p>
      <p><strong>${esc(p.businessName)}</strong> کے لیے FinMatrix ڈیمو بک کرنے کا شکریہ۔ آپ نے <strong>${dateTimePkUr(preferredAt)}</strong> (پاکستانی وقت) کا وقت منتخب کیا ہے۔</p>
      <p>ہماری ٹیم عموماً ایک کاروباری دن کے اندر فون، واٹس ایپ یا ای میل کے ذریعے وقت کی تصدیق کرے گی اور میٹنگ لنک کے ساتھ کیلنڈر دعوت نامہ بھیجے گی۔</p>`;
    return {
      subject:
        p.language === 'ur'
          ? 'FinMatrix ڈیمو کی درخواست موصول ہو گئی'
          : 'We received your FinMatrix demo request',
      html: layout(
        p.language === 'ur'
          ? 'آپ کی ڈیمو کی درخواست موصول ہو گئی'
          : 'Your demo request is in',
        bodyFor(p.language, en, ur),
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
    language: Lang;
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
          Current system: ${esc(input.currentSystem ?? '—')} · Language: ${input.language === 'ur' ? 'Urdu' : 'English'}</p>
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
    const en = `<p>Hi ${esc(p.fullName)},</p>
      <p>Your FinMatrix demo is ${rescheduled ? '<strong>moved to</strong>' : 'booked for'} <strong>${dateTimePk(at)}</strong> (Pakistan time).</p>
      ${meetingLink ? `<p>Join here: <a href="${esc(meetingLink)}">${esc(meetingLink)}</a></p>` : ''}
      <p>The calendar invite is attached — open it to add the demo to your calendar.</p>`;
    const ur = `<p>${esc(p.fullName)} صاحب/صاحبہ،</p>
      <p>آپ کا FinMatrix ڈیمو ${rescheduled ? '<strong>نئے وقت</strong>' : ''} <strong>${dateTimePkUr(at)}</strong> (پاکستانی وقت) کے لیے طے ہو گیا ہے۔</p>
      ${meetingLink ? `<p>میٹنگ لنک: <a href="${esc(meetingLink)}">${esc(meetingLink)}</a></p>` : ''}
      <p>کیلنڈر دعوت نامہ منسلک ہے — اسے کھول کر ڈیمو اپنے کیلنڈر میں شامل کریں۔</p>`;
    return {
      subject: rescheduled
        ? p.language === 'ur'
          ? 'آپ کا FinMatrix ڈیمو نئے وقت پر منتقل ہو گیا'
          : 'Your FinMatrix demo has a new time'
        : p.language === 'ur'
          ? 'آپ کا FinMatrix ڈیمو طے ہو گیا'
          : 'Your FinMatrix demo is booked',
      html: layout(
        p.language === 'ur' ? 'ڈیمو کا وقت' : 'Your demo time',
        bodyFor(p.language, en, ur) + link(meetingLink, 'Join the demo'),
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
    const en = `<p>Hi ${esc(p.fullName)},</p>
      <p>Your FinMatrix demo${when} has been cancelled. If you'd still like one, reply to this email or book a new time on our website.</p>`;
    const ur = `<p>${esc(p.fullName)} صاحب/صاحبہ،</p>
      <p>آپ کا FinMatrix ڈیمو منسوخ کر دیا گیا ہے۔ اگر آپ اب بھی ڈیمو چاہتے ہیں تو اس ای میل کا جواب دیں یا ہماری ویب سائٹ پر نیا وقت بک کریں۔</p>`;
    return {
      subject:
        p.language === 'ur'
          ? 'آپ کا FinMatrix ڈیمو منسوخ ہو گیا'
          : 'Your FinMatrix demo was cancelled',
      html: layout(
        p.language === 'ur' ? 'ڈیمو منسوخ' : 'Demo cancelled',
        bodyFor(p.language, en, ur),
      ),
      text: `Hi ${p.fullName},\n\nYour FinMatrix demo${when} has been cancelled. Reply to book a new time.`,
    };
  },

  reminder(
    p: DemoMailPerson,
    at: Date,
    meetingLink: string | null,
  ): RenderedEmail {
    const en = `<p>Hi ${esc(p.fullName)},</p>
      <p>A reminder: your FinMatrix demo starts at <strong>${dateTimePk(at)}</strong> (Pakistan time).</p>
      ${meetingLink ? `<p>Join here: <a href="${esc(meetingLink)}">${esc(meetingLink)}</a></p>` : ''}`;
    const ur = `<p>${esc(p.fullName)} صاحب/صاحبہ،</p>
      <p>یاد دہانی: آپ کا FinMatrix ڈیمو <strong>${dateTimePkUr(at)}</strong> (پاکستانی وقت) پر شروع ہوگا۔</p>
      ${meetingLink ? `<p>میٹنگ لنک: <a href="${esc(meetingLink)}">${esc(meetingLink)}</a></p>` : ''}`;
    return {
      subject:
        p.language === 'ur'
          ? 'یاد دہانی: آپ کا FinMatrix ڈیمو جلد شروع ہوگا'
          : 'Reminder: your FinMatrix demo is coming up',
      html: layout(
        p.language === 'ur' ? 'ڈیمو کی یاد دہانی' : 'Demo reminder',
        bodyFor(p.language, en, ur) + link(meetingLink, 'Join the demo'),
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
    const en = trialEligible
      ? `<p>Hi ${esc(p.fullName)},</p>
         <p>Thanks for your time on the FinMatrix demo. Your free trial is one step away — sign up with the link below (your details are filled in) and it starts straight away.</p>`
      : `<p>Hi ${esc(p.fullName)},</p>
         <p>Thanks for your time on the FinMatrix demo. Sign up with the link below (your details are filled in), then choose <strong>Request account approval</strong> — our team will switch your plan on. (This email or phone number has already used a free trial.)</p>`;
    const ur = trialEligible
      ? `<p>${esc(p.fullName)} صاحب/صاحبہ،</p>
         <p>FinMatrix ڈیمو کے لیے وقت دینے کا شکریہ۔ نیچے دیے گئے لنک سے سائن اَپ کریں (آپ کی معلومات پہلے سے درج ہیں) اور آپ کا مفت ٹرائل فوراً شروع ہو جائے گا۔</p>`
      : `<p>${esc(p.fullName)} صاحب/صاحبہ،</p>
         <p>FinMatrix ڈیمو کے لیے وقت دینے کا شکریہ۔ نیچے دیے گئے لنک سے سائن اَپ کریں، پھر <strong>اکاؤنٹ کی منظوری کی درخواست</strong> منتخب کریں — ہماری ٹیم آپ کا پلان فعال کر دے گی۔</p>`;
    return {
      subject: trialEligible
        ? p.language === 'ur'
          ? 'اپنا FinMatrix مفت ٹرائل شروع کریں'
          : 'Start your FinMatrix free trial'
        : p.language === 'ur'
          ? 'FinMatrix پر اپنا اکاؤنٹ بنائیں'
          : 'Set up your FinMatrix account',
      html: layout(
        p.language === 'ur'
          ? 'FinMatrix شروع کریں'
          : 'Get started with FinMatrix',
        bodyFor(p.language, en, ur) +
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
