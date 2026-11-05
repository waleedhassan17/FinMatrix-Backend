/**
 * WhatsApp numbers, by the same rule the app and the web use to open a chat
 * (FinMatrix src/utils/whatsappPhone.ts, FinMatrix-Website
 * src/features/share/shareDocument.ts). One rule everywhere means the number a
 * person sees in the wa.me hand-off is the number the server messages.
 *
 *   strip everything but digits
 *   drop a leading 00 (international dialling prefix)
 *   11 digits starting 0  -> 92 + the rest   (0300 1234567)
 *   10 digits starting 3  -> 92 + digits     (300 1234567)
 *   keep 10..15 digits, otherwise it is not a number
 *
 * Unlike the app's version this returns E.164 with the leading '+', which is
 * what is stored in customers.whatsapp_e164 / vendors.whatsapp_e164.
 *
 * The migration 1790500000000-MessagingFoundation backfills existing rows with
 * the SAME rule written in SQL; phone.util.spec.ts holds the shared cases.
 */
export function toWhatsappE164(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (digits.length === 11 && digits.startsWith('0'))
    digits = `92${digits.slice(1)}`;
  else if (digits.length === 10 && digits.startsWith('3'))
    digits = `92${digits}`;
  return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
}

/**
 * A number safe to write to a log: country code and the next three digits,
 * then the last four. `+923001234567` -> `+92300***4567`.
 */
export function maskPhone(e164: string | null | undefined): string {
  if (!e164) return '(none)';
  const digits = String(e164).replace(/\D/g, '');
  if (digits.length < 9) return '+***';
  return `+${digits.slice(0, 5)}***${digits.slice(-4)}`;
}
