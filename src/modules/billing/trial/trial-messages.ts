/**
 * Why a company may not start a free trial — one code per rule, each with a
 * plain-language sentence in English and Urdu. The server sends both; clients
 * show the one in the user's language (and map the code themselves too).
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

export interface BilingualMessage {
  en: string;
  ur: string;
}

export const TRIAL_INELIGIBLE_MESSAGES: Record<
  TrialIneligibleReason,
  BilingualMessage
> = {
  TRIAL_DISABLED: {
    en: "Free trials aren't available right now. Please request account approval instead.",
    ur: 'اس وقت مفت ٹرائل دستیاب نہیں ہے۔ براہِ کرم اس کے بجائے اکاؤنٹ کی منظوری کی درخواست دیں۔',
  },
  TRIAL_NOT_OWNER: {
    en: "Only the company's owner can start the free trial.",
    ur: 'مفت ٹرائل صرف کمپنی کا مالک شروع کر سکتا ہے۔',
  },
  COMPANY_NOT_DRAFT: {
    en: 'This company has already been submitted or activated, so a free trial cannot be started for it.',
    ur: 'یہ کمپنی پہلے ہی جمع یا فعال کی جا چکی ہے، اس لیے اس کے لیے مفت ٹرائل شروع نہیں کیا جا سکتا۔',
  },
  REQUEST_PENDING_REVIEW: {
    en: 'You already have a request awaiting review.',
    ur: 'آپ کی ایک درخواست پہلے ہی جائزے کے لیے زیرِ التوا ہے۔',
  },
  EMAIL_NOT_VERIFIED: {
    en: 'Please verify your email address before starting a free trial.',
    ur: 'مفت ٹرائل شروع کرنے سے پہلے براہِ کرم اپنے ای میل ایڈریس کی تصدیق کریں۔',
  },
  TRIAL_PHONE_REQUIRED: {
    en: 'A valid Pakistani phone number is required to start a free trial.',
    ur: 'مفت ٹرائل شروع کرنے کے لیے ایک درست پاکستانی فون نمبر ضروری ہے۔',
  },
  TRIAL_EMAIL_DOMAIN_BLOCKED: {
    en: "Free trials need a permanent email address. Temporary or disposable email addresses can't be used.",
    ur: 'مفت ٹرائل کے لیے مستقل ای میل ایڈریس ضروری ہے۔ عارضی یا ڈسپوزایبل ای میل استعمال نہیں کی جا سکتی۔',
  },
  TRIAL_USER_USED: {
    en: 'Your account has already used its free trial.',
    ur: 'آپ کا اکاؤنٹ اپنا مفت ٹرائل پہلے ہی استعمال کر چکا ہے۔',
  },
  TRIAL_EMAIL_USED: {
    en: 'This email address has already used its free trial.',
    ur: 'یہ ای میل ایڈریس اپنا مفت ٹرائل پہلے ہی استعمال کر چکا ہے۔',
  },
  TRIAL_PHONE_USED: {
    en: 'This phone number has already used its free trial.',
    ur: 'یہ فون نمبر اپنا مفت ٹرائل پہلے ہی استعمال کر چکا ہے۔',
  },
  TRIAL_ALREADY_USED: {
    en: 'This company has already used its free trial.',
    ur: 'یہ کمپنی اپنا مفت ٹرائل پہلے ہی استعمال کر چکی ہے۔',
  },
  TRIAL_TAX_ID_USED: {
    en: 'This NTN has already been used for a free trial.',
    ur: 'یہ این ٹی این پہلے ہی مفت ٹرائل کے لیے استعمال ہو چکا ہے۔',
  },
  NO_PLANS_FOR_COMPANY_TYPE: {
    en: "Free trials aren't available for this type of company.",
    ur: 'اس قسم کی کمپنی کے لیے مفت ٹرائل دستیاب نہیں ہے۔',
  },
};

/** What the owner sees when a trial is held for manual review. */
export const TRIAL_HELD_MESSAGE: BilingualMessage = {
  en: "We're reviewing your trial — usually within a few hours. We'll email you as soon as it starts.",
  ur: 'ہم آپ کے ٹرائل کا جائزہ لے رہے ہیں — عموماً چند گھنٹوں میں۔ ٹرائل شروع ہوتے ہی ہم آپ کو ای میل کریں گے۔',
};

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
  const m = TRIAL_INELIGIBLE_MESSAGES[reason];
  // Only `code`, `message` and `details` survive the exception filter.
  return {
    code: 'TRIAL_NOT_ELIGIBLE',
    message: m.en,
    details: { reason, messageUr: m.ur },
  };
}
