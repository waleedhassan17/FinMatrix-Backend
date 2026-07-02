/**
 * phase2.md — PLAN CONFIG: the single, server-side source of truth for the
 * subscription plans. Amounts are in MINOR UNITS (paisa: 100 paisa = Rs 1).
 * The client NEVER sets the price — it is always read from here on submit.
 *
 *   Free     — Rs 0,     no expiry,   1 delivery-personnel
 *   Standard — Rs 1,000, 6 months,    3 delivery-personnel
 *   Pro      — Rs 2,000, 3 months,    3 delivery-personnel
 *
 * All accounting features are available on EVERY plan; the only plan difference
 * enforced anywhere is `deliveryPersonnelLimit`.
 */
export type PlanKey = 'free' | 'standard' | 'pro';

export interface PlanConfig {
  key: PlanKey;
  label: string;
  /** Price in minor units (paisa). Divide by 100 for rupees. */
  priceMinorUnits: number;
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
    durationMonths: null,
    deliveryPersonnelLimit: 1,
    currency: 'PKR',
  },
  standard: {
    key: 'standard',
    label: 'Standard',
    priceMinorUnits: 100000, // Rs 1,000
    durationMonths: 6,
    deliveryPersonnelLimit: 3,
    currency: 'PKR',
  },
  pro: {
    key: 'pro',
    label: 'Pro',
    priceMinorUnits: 200000, // Rs 2,000
    durationMonths: 3,
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
