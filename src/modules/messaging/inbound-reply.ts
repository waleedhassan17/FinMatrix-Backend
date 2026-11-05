import { MessageLanguage } from './messaging.constants';

/**
 * What FinMatrix answers when a customer or vendor writes to its WhatsApp
 * number (decision D36). One place, so a chatbot can replace it later
 * without touching the webhook or the dispatcher.
 *
 * The number belongs to FinMatrix, not to the company, so the answer says
 * whose documents it carries and how to reach that company directly.
 */
export interface InboundReplyContext {
  /** The company whose message this customer received last. */
  companyName: string;
  companyPhone?: string | null;
  companyEmail?: string | null;
  language: MessageLanguage;
}

export function inboundReply(
  ctx: InboundReplyContext,
): { text: string } | null {
  const company = (ctx.companyName ?? '').trim();
  if (!company) return null;
  const phone = (ctx.companyPhone ?? '').trim();
  const email = (ctx.companyEmail ?? '').trim();

  if (ctx.language === 'ur') {
    // NEEDS NATIVE REVIEW
    const reach =
      phone && email
        ? `${company} سے رابطے کے لیے ${phone} پر کال یا واٹس ایپ کریں، یا ${email} پر ای میل کریں۔`
        : phone
          ? `${company} سے رابطے کے لیے ${phone} پر کال یا واٹس ایپ کریں۔`
          : email
            ? `${company} سے رابطے کے لیے ${email} پر ای میل کریں۔`
            : `${company} سے رابطے کے لیے ان کی بھیجی ہوئی دستاویز پر دیے گئے رابطہ نمبر استعمال کریں۔`;
    return {
      text:
        `یہ ${company} کے لیے FinMatrix کا خودکار نمبر ہے، یہاں بھیجے گئے پیغامات پڑھے نہیں جاتے۔ ` +
        `${reach} یہ پیغامات بند کرنے کے لیے STOP لکھیں۔`,
    };
  }

  const reach =
    phone && email
      ? `To reach ${company}, call or WhatsApp ${phone}, or email ${email}.`
      : phone
        ? `To reach ${company}, call or WhatsApp ${phone}.`
        : email
          ? `To reach ${company}, email ${email}.`
          : `To reach ${company}, please use the contact details on the document they sent you.`;
  return {
    text:
      `This is FinMatrix's automatic number for ${company}; messages sent here are not read. ` +
      `${reach} Reply STOP to stop these messages.`,
  };
}
