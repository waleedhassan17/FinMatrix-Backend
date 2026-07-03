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
export type PlanKey = 'free' | 'standard' | 'pro';

export interface PlanConfig {
  key: PlanKey;
  label: string;
  /** TOTAL price for the whole duration, in minor units (paisa). */
  priceMinorUnits: number;
  /** Per-month price in minor units (priceMinorUnits = monthly × duration). */
  monthlyMinorUnits: number;
  /** Subscription length in months; null = never expires (Free). */
  durationMonths: number | null;
  /** Max simultaneously-active delivery personnel allowed on this plan. */
  deliveryPersonnelLimit: number;
  currency: string;
}

export const PLAN_CONFIG: Record<PlanKey, PlanConfig> = {
  free: {
    key: 'free',
    label: 'Free',
    priceMinorUnits: 0,
    monthlyMinorUnits: 0,
    durationMonths: null,
    deliveryPersonnelLimit: 1,
    currency: 'PKR',
  },
  standard: {
    key: 'standard',
    label: 'Standard',
    priceMinorUnits: 600000, // Rs 6,000 total = Rs 1,000/month × 6 months
    monthlyMinorUnits: 100000, // Rs 1,000/month
    durationMonths: 6,
    deliveryPersonnelLimit: 3,
    currency: 'PKR',
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    priceMinorUnits: 400000, // Rs 4,000 total = Rs 2,000/month × 2 months
    monthlyMinorUnits: 200000, // Rs 2,000/month
    durationMonths: 2,
    deliveryPersonnelLimit: 3,
    currency: 'PKR',
  },
};

export const PLAN_KEYS: PlanKey[] = ['free', 'standard', 'pro'];

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
