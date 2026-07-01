/**
 * Canonical account-status model (Phase1.md): a company is one of
 * `pending | active | inactive | rejected`. Login/app access is allowed ONLY
 * when active. This normalizes the fragmented historical values (Stage-1 state
 * machine + legacy) onto that model so existing companies keep working.
 */
export type AccountStatus = 'pending' | 'active' | 'inactive' | 'rejected';

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
    // unverified | email_verified | pending_approval | pending | trial | …
    default:
      return 'pending';
  }
}

export function isCompanyActive(raw: string | null | undefined): boolean {
  return normalizeCompanyStatus(raw) === 'active';
}
