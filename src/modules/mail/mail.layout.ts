/**
 * Shared building blocks for every FinMatrix email: the HTML document shell,
 * the button, escaping, and dates in Asia/Karachi.
 */

export const BRAND = '#1f6feb';

/** An attachment carried by an email (e.g. a demo's .ics calendar invite). */
export interface EmailAttachment {
  filename: string;
  content: string | Buffer;
  contentType: string;
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
  attachments?: EmailAttachment[];
}

/**
 * Every email is a complete HTML document: language, charset and a title.
 * Head-less HTML is one of the things spam filters score, and a missing
 * charset garbles non-ASCII names in some clients.
 */
export function layout(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${esc(title)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f6f8;font-family:Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
    <div style="max-width:560px;margin:24px auto;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e7eb;">
      <div style="background:${BRAND};padding:20px 28px;">
        <span style="color:#ffffff;font-size:20px;font-weight:700;">FinMatrix</span>
      </div>
      <div style="padding:28px;">
        <h2 style="margin:0 0 16px;font-size:18px;">${esc(title)}</h2>
        ${bodyHtml}
      </div>
      <div style="padding:16px 28px;background:#f9fafb;border-top:1px solid #e5e7eb;font-size:12px;color:#6b7280;">
        You received this email because of activity on your FinMatrix account.
      </div>
    </div>
  </body>
</html>`;
}

export function button(href: string, label: string): string {
  return `<a href="${href}" style="display:inline-block;background:${BRAND};color:#ffffff;text-decoration:none;padding:12px 22px;border-radius:8px;font-weight:600;">${label}</a>`;
}

/**
 * HTML-escape a value interpolated into a template. Used wherever a template
 * carries free text a person typed (a rejection reason, a company name).
 */
export function esc(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** "15 October 2026" — unambiguous in Pakistan, unlike 10/15/2026. */
export function longDate(d: Date): string {
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Karachi',
  });
}

/** "Wed 3 Dec 2026, 11:30 am" in Asia/Karachi — for demo times. */
export function dateTimePk(d: Date): string {
  return d.toLocaleString('en-GB', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'Asia/Karachi',
  });
}
