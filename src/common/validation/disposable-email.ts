import { trialBlockedEmailDomains } from '../../config/launch.settings';
import { DISPOSABLE_EMAIL_DOMAINS_SNAPSHOT } from './disposable-email-domains';
import { emailDomain } from './contact-normalize';

let bundled: Set<string> | null = null;

function bundledDomains(): Set<string> {
  if (!bundled) {
    bundled = new Set(
      DISPOSABLE_EMAIL_DOMAINS_SNAPSHOT.split('\n')
        .map((d) => d.trim())
        .filter(Boolean),
    );
  }
  return bundled;
}

/**
 * True when an address's domain (or any parent domain of it) is a disposable
 * mailbox provider or listed in TRIAL_BLOCKED_EMAIL_DOMAINS.
 * `x@mail.temp-mail.org` is caught by the `temp-mail.org` entry.
 */
export function isBlockedEmailDomain(raw: unknown): boolean {
  const domain = emailDomain(raw);
  if (!domain) return false;
  const extra = new Set(trialBlockedEmailDomains());
  const list = bundledDomains();
  const labels = domain.split('.');
  for (let i = 0; i < labels.length - 1; i += 1) {
    const candidate = labels.slice(i).join('.');
    if (list.has(candidate) || extra.has(candidate)) return true;
  }
  return false;
}
