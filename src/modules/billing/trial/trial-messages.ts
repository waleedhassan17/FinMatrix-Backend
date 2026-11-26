/**
 * Why a company may not start a free trial — one code per rule, each with a
 * plain-language sentence. Clients map the code themselves too.
 *
 * The messages never name another company or user: "this phone number has
 * already used its free trial" says nothing about whose.
 */
export type TrialIneligibleReason =
  | 'TRIAL_DISABLED'
  | 'TRIAL_NOT_OWNER'
  | 'COMPANY_NOT_DRAFT'
  | 'REQUEST_PENDING_REVIEW'
  | 'EMAIL_NOT_VERIFIED'
  | 'TRIAL_PHONE_REQUIRED'
  | 'TRIAL_EMAIL_DOMAIN_BLOCKED'
  | 'TRIAL_USER_USED'
  | 'TRIAL_EMAIL_USED'
  | 'TRIAL_PHONE_USED'
  | 'TRIAL_ALREADY_USED'
  | 'TRIAL_TAX_ID_USED'
  | 'NO_PLANS_FOR_COMPANY_TYPE';

export const TRIAL_INELIGIBLE_MESSAGES: Record<TrialIneligibleReason, string> =
  {
    TRIAL_DISABLED:
      "Free trials aren't available right now. Please request account approval instead.",
    TRIAL_NOT_OWNER: "Only the company's owner can start the free trial.",
    COMPANY_NOT_DRAFT:
      'This company has already been submitted or activated, so a free trial cannot be started for it.',
    REQUEST_PENDING_REVIEW: 'You already have a request awaiting review.',
    EMAIL_NOT_VERIFIED:
      'Please verify your email address before starting a free trial.',
    TRIAL_PHONE_REQUIRED:
      'A valid Pakistani phone number is required to start a free trial.',
    TRIAL_EMAIL_DOMAIN_BLOCKED:
      "Free trials need a permanent email address. Temporary or disposable email addresses can't be used.",
    TRIAL_USER_USED: 'Your account has already used its free trial.',
    TRIAL_EMAIL_USED: 'This email address has already used its free trial.',
    TRIAL_PHONE_USED: 'This phone number has already used its free trial.',
    TRIAL_ALREADY_USED: 'This company has already used its free trial.',
    TRIAL_TAX_ID_USED: 'This NTN has already been used for a free trial.',
    NO_PLANS_FOR_COMPANY_TYPE:
      "Free trials aren't available for this type of company.",
  };

/** What the owner sees when a trial is held for manual review. */
export const TRIAL_HELD_MESSAGE =
  "We're reviewing your trial — usually within a few hours. We'll email you as soon as it starts.";

/** The unique index each identity is enforced by → the reason its violation means. */
export const TRIAL_CLAIM_CONSTRAINT_REASONS: Record<
  string,
  TrialIneligibleReason
> = {
  ux_trial_claims_company: 'TRIAL_ALREADY_USED',
  ux_trial_claims_user: 'TRIAL_USER_USED',
  ux_trial_claims_email: 'TRIAL_EMAIL_USED',
  ux_trial_claims_phone: 'TRIAL_PHONE_USED',
  ux_trial_claims_tax_id: 'TRIAL_TAX_ID_USED',
};

/** The body of a 409 TRIAL_NOT_ELIGIBLE answer. */
export function trialNotEligibleBody(reason: TrialIneligibleReason) {
  // Only `code`, `message` and `details` survive the exception filter.
  return {
    code: 'TRIAL_NOT_ELIGIBLE',
    message: TRIAL_INELIGIBLE_MESSAGES[reason],
    details: { reason },
  };
}
