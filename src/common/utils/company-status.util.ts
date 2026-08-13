/**
 * Canonical account-status model (Phase1.md): a company is one of
 * `draft | pending | active | inactive | rejected`. Login/app access is allowed
 * ONLY when active. This normalizes the fragmented historical values (Stage-1
 * state machine + legacy) onto that model so existing companies keep working.
 *
 * `draft` vs `pending` is a real distinction and must not be collapsed:
 *
 *   draft   — the owner created the company but has NOT submitted it. There is
 *             no plan yet (submitForApproval refuses without one), so the next
 *             thing they need is the rest of onboarding.
 *   pending — submitted, waiting on a platform admin. Nothing for the owner to
 *             do but wait.
 *
 * They used to share the value `pending`, so a half-finished registration was
 * shown "Awaiting approval" — a screen for work the user had not done — with
 * no route back to plan selection, and the sign-in gate locked them out of
 * their own unfinished onboarding as soon as their token expired.
 */
export type AccountStatus =
  | 'draft'
  | 'pending'
  | 'active'
  | 'inactive'
  | 'rejected';

export function normalizeCompanyStatus(
  raw: string | null | undefined,
): AccountStatus {
  // Legacy rows with no status are treated as active (they predate this model).
  if (raw === null || raw === undefined || raw === '') return 'active';
  switch (raw) {
    case 'active':
    case 'approved':
      return 'active';
    case 'rejected':
      return 'rejected';
    case 'inactive':
    case 'suspended':
      return 'inactive';
    // Created but never submitted — onboarding is still in progress.
    case 'email_verified':
      return 'draft';
    // unverified | pending_approval | pending | trial | …
    default:
      return 'pending';
  }
}

/** True while the owner still has onboarding steps left to complete. */
export function isCompanyDraft(raw: string | null | undefined): boolean {
  return normalizeCompanyStatus(raw) === 'draft';
}

export function isCompanyActive(raw: string | null | undefined): boolean {
  return normalizeCompanyStatus(raw) === 'active';
}

// ─── Live subscription-expiry check (phase2 follow-up) ─────────────────────
// The daily 1AM billing cron is what durably flips an expired company to
// status='inactive' (with reminders + notifications). These helpers close the
// window between the actual expiry timestamp and that scan: request-time
// gates (CompanyGuard, signin, /auth/me) treat a paid plan whose expiry date
// has passed as ALREADY inactive, so access ends the moment the subscription
// does — the cron then makes it durable. Free plans never expire.

export interface SubscriptionFields {
  subscriptionPlan?: string | null;
  subscriptionExpiryDate?: Date | string | null;
  /** none | submitted | paid | rejected — set when a receipt is uploaded. */
  paymentStatus?: string | null;
}

export function isSubscriptionExpired(
  company: SubscriptionFields,
  now: Date = new Date(),
): boolean {
  const plan = company.subscriptionPlan ?? 'free';
  if (plan === 'free') return false;
  const expiry = company.subscriptionExpiryDate;
  if (!expiry) return false;
  const t = new Date(expiry).getTime();
  return Number.isFinite(t) && t <= now.getTime();
}

/**
 * Account status with the live expiry check applied: an otherwise-active
 * company whose paid subscription has lapsed reports `inactive` (renew-only),
 * exactly what the cron will persist at its next run.
 */
export function effectiveCompanyStatus(
  company: (SubscriptionFields & { status?: string | null }) | null | undefined,
  now: Date = new Date(),
): AccountStatus {
  const status = normalizeCompanyStatus(company?.status);
  if (status === 'active' && company && isSubscriptionExpired(company, now)) {
    return 'inactive';
  }
  // A draft whose payment receipt is with an administrator is genuinely
  // awaiting review, so it must report `pending` — even though the raw
  // company.status is only flipped to `active` on approval. Without this the
  // owner is bounced back to plan selection after paying, and could pay twice.
  if (status === 'draft' && company?.paymentStatus === 'submitted') {
    return 'pending';
  }
  return status;
}
