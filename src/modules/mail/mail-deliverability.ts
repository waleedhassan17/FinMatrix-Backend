/**
 * Configuration that sends email to spam, checked once at startup.
 *
 * Whether a message lands in the inbox is decided mostly outside the code: by
 * whether the sending domain publishes SPF, DKIM and DMARC records and the
 * From address lines up with them, and by the reputation of the domains it
 * links to. Those mistakes are silent, so they are put in the log instead.
 */

/** Free mailbox providers: fine for people, a spam signal for automated mail. */
const PERSONAL_MAILBOX_DOMAINS = new Set([
  'gmail.com',
  'googlemail.com',
  'yahoo.com',
  'ymail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'icloud.com',
  'me.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'mail.com',
  'yandex.com',
  'zoho.com',
]);

/**
 * Platforms whose free subdomains anyone can publish on. Phishing kits live
 * there too, so filters treat links to them as high-risk.
 */
const SHARED_HOSTING_SUFFIXES = [
  'vercel.app',
  'netlify.app',
  'herokuapp.com',
  'onrender.com',
  'railway.app',
  'github.io',
  'pages.dev',
  'web.app',
  'firebaseapp.com',
  'azurewebsites.net',
  'fly.dev',
];

/** The domain of an address, from "Name <user@domain>" or "user@domain". */
export function emailDomain(address: string | null | undefined): string | null {
  const match = /@([a-z0-9.-]+\.[a-z]{2,})\s*>?\s*$/i.exec(
    (address ?? '').trim(),
  );
  return match ? match[1].toLowerCase() : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const onDomain = (host: string, domain: string) =>
  host === domain || host.endsWith(`.${domain}`);

export interface DeliverabilityInput {
  /** The From header, e.g. `FinMatrix <no-reply@finmatrix.pk>`. */
  from: string;
  /** The SMTP login. An email address for most providers; an access key for SES. */
  smtpUser: string;
  /** Where the links in emails point (WEB_APP_URL). */
  webAppUrl: string;
}

/** Plain-language warnings, one per problem; empty when nothing is wrong. */
export function deliverabilityWarnings(input: DeliverabilityInput): string[] {
  const warnings: string[] = [];
  const fromDomain = emailDomain(input.from);
  const userDomain = input.smtpUser.includes('@')
    ? emailDomain(input.smtpUser)
    : null;
  const linkHost = hostOf(input.webAppUrl);

  if (!fromDomain) {
    warnings.push(
      `SMTP_FROM ("${input.from}") has no email address in it. Set it to an address on your own domain, e.g. "FinMatrix <no-reply@your-domain>".`,
    );
  } else if (PERSONAL_MAILBOX_DOMAINS.has(fromDomain)) {
    warnings.push(
      `Emails are sent from a personal mailbox (@${fromDomain}). Mail filters treat automated email from personal addresses, ` +
        'especially under a company name, as likely spam. Send from an address on your own domain through a transactional ' +
        'provider (for example Amazon SES), with SPF, DKIM and DMARC records published for that domain.',
    );
  } else if (userDomain && userDomain !== fromDomain) {
    warnings.push(
      `SMTP_FROM is on ${fromDomain} but the SMTP account is on ${userDomain}. Unless that provider is authorised to send ` +
        `for ${fromDomain} (SPF and DKIM), DMARC fails and the mail goes to spam or is rejected.`,
    );
  }

  if (linkHost) {
    const shared = SHARED_HOSTING_SUFFIXES.find((s) => onDomain(linkHost, s));
    if (shared) {
      warnings.push(
        `Links in emails point at ${linkHost}, a shared ${shared} address. Mail filters score links on shared hosting ` +
          'as high-risk. Serve the web app from your own domain (for example app.your-domain) and set WEB_APP_URL to it.',
      );
    } else if (
      fromDomain &&
      !PERSONAL_MAILBOX_DOMAINS.has(fromDomain) &&
      !onDomain(linkHost, fromDomain)
    ) {
      warnings.push(
        `Links in emails go to ${linkHost}, a different domain from the sender (${fromDomain}). Links on the sender's ` +
          'own domain are trusted more.',
      );
    }
  }
  return warnings;
}

type TxtResolver = (hostname: string) => Promise<string[][]>;

const flat = (records: string[][]) => records.map((chunks) => chunks.join(''));

/**
 * What the sending domain's DNS is missing for mail to be trusted: SPF (who
 * may send for it) and DMARC (what receivers do when that check fails). DKIM
 * needs the provider's selector, so it cannot be checked from here.
 *
 * Best-effort: a lookup that times out or fails says nothing, because a DNS
 * hiccup at boot is not a configuration problem.
 */
export async function senderDnsWarnings(
  domain: string | null,
  resolveTxt: TxtResolver,
  timeoutMs = 3000,
): Promise<string[]> {
  if (!domain || PERSONAL_MAILBOX_DOMAINS.has(domain)) return [];

  const lookup = async (name: string): Promise<string[] | 'missing' | null> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
      });
      return flat(await Promise.race([resolveTxt(name), timeout]));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return code === 'ENOTFOUND' || code === 'ENODATA' ? 'missing' : null;
    } finally {
      clearTimeout(timer);
    }
  };

  const [root, dmarc] = await Promise.all([
    lookup(domain),
    lookup(`_dmarc.${domain}`),
  ]);
  const warnings: string[] = [];
  if (root === 'missing') {
    warnings.push(
      `${domain}, the domain email is sent from, has no DNS records. Receivers reject or junk mail from a domain they ` +
        'cannot look up. Send from a domain you own and have set up for email.',
    );
    return warnings;
  }
  if (Array.isArray(root) && !root.some((r) => /^v=spf1\b/i.test(r))) {
    warnings.push(
      `${domain} publishes no SPF record, so receivers cannot tell your mail server is allowed to send for it. ` +
        'Add the TXT record your email provider gives you (it starts with "v=spf1").',
    );
  }
  if (
    dmarc === 'missing' ||
    (Array.isArray(dmarc) && !dmarc.some((r) => /^v=DMARC1\b/i.test(r)))
  ) {
    warnings.push(
      `${domain} publishes no DMARC record. Gmail and Yahoo expect one from every sender; add a TXT record at ` +
        `_dmarc.${domain}, e.g. "v=DMARC1; p=none; rua=mailto:dmarc@${domain}".`,
    );
  }
  return warnings;
}
