/**
 * phase2.md — PLAN CONFIG: the single, server-side source of truth for the
 * subscription plans. Amounts are in MINOR UNITS (paisa: 100 paisa = Rs 1).
 * The client NEVER sets the price — it is always read from here on submit.
 *
 *   Free     — Rs 0,           no expiry,                    1 delivery-personnel
 *   Standard — Rs 1,000/month, 6 months (Rs 6,000 total),    3 delivery-personnel
 *   Pro      — Rs 2,000/month, 2 months (Rs 4,000 total),    3 delivery-personnel
 *
 * `priceMinorUnits` is the TOTAL charged up-front for the whole duration
 * (monthlyMinorUnits × durationMonths) — the manual bank transfer is one
 * payment for the full period.
 *
 * All accounting features are available on EVERY plan; the only plan difference
 * enforced anywhere is `deliveryPersonnelLimit`.
 */
/**
 * Legacy keys (free|standard|pro) predate the three-tier model. They stay in
 * the config so existing companies' rows keep resolving (limits, renewals,
 * expiry cron) — but they are NEVER offered to new registrations. The six
 * tier plans (FinMatrix.md, CONFIRMED FINAL PRICING) are the only selectable
 * ones; each type shows exactly its two plans (3-month and 6-month, the
 * 6-month at a lower effective monthly rate). NO free plan in the new model.
 */
export type LegacyPlanKey = 'free' | 'standard' | 'pro';
export type TierPlanKey =
  | 'small_business_3mo'
  | 'small_business_6mo'
  | 'large_org_3mo'
  | 'large_org_6mo'
  | 'warehouse_3mo'
  | 'warehouse_6mo';
export type PlanKey = LegacyPlanKey | TierPlanKey;

export type PlanCompanyType = 'small_business' | 'large_org' | 'warehouse';

export interface PlanConfig {
  key: PlanKey;
  label: string;
  /** Which company type may buy this plan; null = legacy (any, not offered). */
  companyType: PlanCompanyType | null;
  /** TOTAL price for the whole duration, in minor units (paisa). */
  priceMinorUnits: number;
  /** Per-month price in minor units (priceMinorUnits = monthly × duration). */
  monthlyMinorUnits: number;
  /** Subscription length in months; null = never expires (legacy Free only). */
  durationMonths: number | null;
  /** Max simultaneously-active delivery personnel allowed on this plan. */
  deliveryPersonnelLimit: number;
  currency: string;
}

export const PLAN_CONFIG: Record<PlanKey, PlanConfig> = {
  // ── Legacy (pre-tiering) — resolvable, never offered ──
  free: {
    key: 'free',
    label: 'Free',
    companyType: null,
    priceMinorUnits: 0,
    monthlyMinorUnits: 0,
    durationMonths: null,
    deliveryPersonnelLimit: 1,
    currency: 'PKR',
  },
  standard: {
    key: 'standard',
    label: 'Standard',
    companyType: null,
    priceMinorUnits: 600000, // Rs 6,000 total = Rs 1,000/month × 6 months
    monthlyMinorUnits: 100000, // Rs 1,000/month
    durationMonths: 6,
    deliveryPersonnelLimit: 3,
    currency: 'PKR',
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    companyType: null,
    priceMinorUnits: 400000, // Rs 4,000 total = Rs 2,000/month × 2 months
    monthlyMinorUnits: 200000, // Rs 2,000/month
    durationMonths: 2,
    deliveryPersonnelLimit: 3,
    currency: 'PKR',
  },

  // ── Three-tier plans (FinMatrix.md CONFIRMED FINAL PRICING, PKR) ──
  small_business_3mo: {
    key: 'small_business_3mo',
    label: 'Small Business — 3 months',
    companyType: 'small_business',
    priceMinorUnits: 750000, // Rs 7,500 total
    monthlyMinorUnits: 250000, // Rs 2,500/month
    durationMonths: 3,
    deliveryPersonnelLimit: 0, // no delivery module on this tier
    currency: 'PKR',
  },
  small_business_6mo: {
    key: 'small_business_6mo',
    label: 'Small Business — 6 months',
    companyType: 'small_business',
    priceMinorUnits: 1200000, // Rs 12,000 total
    monthlyMinorUnits: 200000, // Rs 2,000/month — lower than 3mo
    durationMonths: 6,
    deliveryPersonnelLimit: 0,
    currency: 'PKR',
  },
  large_org_3mo: {
    key: 'large_org_3mo',
    label: 'Large Organization — 3 months',
    companyType: 'large_org',
    priceMinorUnits: 1500000, // Rs 15,000 total
    monthlyMinorUnits: 500000, // Rs 5,000/month
    durationMonths: 3,
    deliveryPersonnelLimit: 0, // no delivery module on this tier
    currency: 'PKR',
  },
  large_org_6mo: {
    key: 'large_org_6mo',
    label: 'Large Organization — 6 months',
    companyType: 'large_org',
    priceMinorUnits: 2400000, // Rs 24,000 total
    monthlyMinorUnits: 400000, // Rs 4,000/month — lower than 3mo
    durationMonths: 6,
    deliveryPersonnelLimit: 0,
    currency: 'PKR',
  },
  warehouse_3mo: {
    key: 'warehouse_3mo',
    label: 'Warehouse — 3 months',
    companyType: 'warehouse',
    priceMinorUnits: 1200000, // Rs 12,000 total
    monthlyMinorUnits: 400000, // Rs 4,000/month
    durationMonths: 3,
    deliveryPersonnelLimit: 3,
    currency: 'PKR',
  },
  warehouse_6mo: {
    key: 'warehouse_6mo',
    label: 'Warehouse — 6 months',
    companyType: 'warehouse',
    priceMinorUnits: 1800000, // Rs 18,000 total
    monthlyMinorUnits: 300000, // Rs 3,000/month — lower than 3mo
    durationMonths: 6,
    deliveryPersonnelLimit: 5,
    currency: 'PKR',
  },
};

export const PLAN_KEYS: PlanKey[] = [
  'free',
  'standard',
  'pro',
  'small_business_3mo',
  'small_business_6mo',
  'large_org_3mo',
  'large_org_6mo',
  'warehouse_3mo',
  'warehouse_6mo',
];

export const TIER_PLAN_KEYS: TierPlanKey[] = [
  'small_business_3mo',
  'small_business_6mo',
  'large_org_3mo',
  'large_org_6mo',
  'warehouse_3mo',
  'warehouse_6mo',
];

/** The two selectable plans (3mo, 6mo) for a company type. */
export function plansForType(companyType: string | null | undefined): PlanConfig[] {
  return TIER_PLAN_KEYS.map((k) => PLAN_CONFIG[k]).filter((p) => p.companyType === companyType);
}

export function isPlanKey(v: unknown): v is PlanKey {
  return typeof v === 'string' && (PLAN_KEYS as string[]).includes(v);
}

export function normalizePlan(raw: string | null | undefined): PlanKey {
  return isPlanKey(raw) ? raw : 'free';
}

export function getPlanConfig(raw: string | null | undefined): PlanConfig {
  return PLAN_CONFIG[normalizePlan(raw)];
}

/** Rs amount as a display string, e.g. 100000 → "Rs 1,000". */
export function formatMinorUnits(minor: number, currency = 'PKR'): string {
  const symbol = currency === 'PKR' ? 'Rs' : currency;
  return `${symbol} ${(minor / 100).toLocaleString('en-US')}`;
}

/**
 * The platform's manual bank-transfer destination. Shown on every bill so the
 * company can transfer the fee and upload the screenshot. Overridable via env
 * for real deployments; defaults to the configured account (phase2.md).
 */
export interface PlatformBankAccount {
  accountTitle: string;
  bankName: string;
  accountNumber: string;
  instructions: string;
}

// The account number alone is enough to receive the transfer. Override any
// field via env (PLATFORM_BANK_ACCOUNT / PLATFORM_BANK_TITLE / PLATFORM_BANK_NAME).
export function getPlatformBank(env: NodeJS.ProcessEnv = process.env): PlatformBankAccount {
  return {
    accountTitle: env.PLATFORM_BANK_TITLE || 'Muhammad Waleed Hassan',
    bankName: env.PLATFORM_BANK_NAME || 'Allied Bank',
    accountNumber: env.PLATFORM_BANK_ACCOUNT || '12860010124896560019',
    instructions:
      'Transfer the exact amount shown to the account above, then upload a clear ' +
      'screenshot of the transfer receipt. Your plan activates once an ' +
      'administrator verifies the payment.',
  };
}
