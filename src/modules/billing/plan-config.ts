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
  | 'warehouse_starter_6mo'
  | 'warehouse_starter_1yr'
  | 'warehouse_growth_6mo'
  | 'warehouse_growth_1yr'
  | 'warehouse_scale_6mo'
  | 'warehouse_scale_1yr';

/** Retired warehouse keys — resolvable for grandfathering, never offered. */
export type RetiredPlanKey = 'warehouse_3mo' | 'warehouse_6mo';
/** The admin-approved free trial — granted, never bought. */
export type TrialPlanKey = 'warehouse_trial';
export type PlanKey = LegacyPlanKey | TierPlanKey | RetiredPlanKey | TrialPlanKey;

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
  /**
   * Subscription length in months; null = never expires (legacy Free only) —
   * unless `durationDays` is set.
   */
  durationMonths: number | null;
  /**
   * Length in DAYS for a plan that is not sold by the month (the free trial).
   * The trial's expiry is set at approval from this; a plan with durationDays
   * does expire even though durationMonths is null.
   */
  durationDays?: number;
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
    companyType: null, // WAREHOUSE-ONLY: was 'small_business'
    priceMinorUnits: 750000, // Rs 7,500 total
    monthlyMinorUnits: 250000, // Rs 2,500/month
    durationMonths: 3,
    deliveryPersonnelLimit: 0, // no delivery module on this tier
    currency: 'PKR',
  },
  small_business_6mo: {
    key: 'small_business_6mo',
    label: 'Small Business — 6 months',
    companyType: null, // WAREHOUSE-ONLY: was 'small_business'
    priceMinorUnits: 1200000, // Rs 12,000 total
    monthlyMinorUnits: 200000, // Rs 2,000/month — lower than 3mo
    durationMonths: 6,
    deliveryPersonnelLimit: 0,
    currency: 'PKR',
  },
  large_org_3mo: {
    key: 'large_org_3mo',
    label: 'Large Organization — 3 months',
    companyType: null, // WAREHOUSE-ONLY: was 'large_org'
    priceMinorUnits: 1500000, // Rs 15,000 total
    monthlyMinorUnits: 500000, // Rs 5,000/month
    durationMonths: 3,
    deliveryPersonnelLimit: 0, // no delivery module on this tier
    currency: 'PKR',
  },
  large_org_6mo: {
    key: 'large_org_6mo',
    label: 'Large Organization — 6 months',
    companyType: null, // WAREHOUSE-ONLY: was 'large_org'
    priceMinorUnits: 2400000, // Rs 24,000 total
    monthlyMinorUnits: 400000, // Rs 4,000/month — lower than 3mo
    durationMonths: 6,
    deliveryPersonnelLimit: 0,
    currency: 'PKR',
  },
  // ── Superseded warehouse plans (companyType null ⇒ never offered) ──
  // Replaced by the Starter/Growth/Scale ladder below, which differentiates
  // on delivery-personnel allowance. Kept resolvable so a company already
  // paid up on one keeps its limit, expiry and renewal path until it moves
  // to a new plan — the same grandfathering the legacy keys above use.
  warehouse_3mo: {
    key: 'warehouse_3mo',
    label: 'Warehouse — 3 months (retired)',
    companyType: null,
    priceMinorUnits: 1200000, // Rs 12,000 total
    monthlyMinorUnits: 400000, // Rs 4,000/month
    durationMonths: 3,
    deliveryPersonnelLimit: 3,
    currency: 'PKR',
  },
  warehouse_6mo: {
    key: 'warehouse_6mo',
    label: 'Warehouse — 6 months (retired)',
    companyType: null,
    priceMinorUnits: 1800000, // Rs 18,000 total
    monthlyMinorUnits: 300000, // Rs 3,000/month
    durationMonths: 6,
    deliveryPersonnelLimit: 5,
    currency: 'PKR',
  },

  // ── Warehouse ladder — the only plans on offer ────────────────────────
  // Tiers differ ONLY by how many delivery personnel may be active at once
  // (3 / 5 / 10); every accounting and warehouse feature is on all three.
  // Each rung is sold as 6 months or 1 year, the annual at 75% of the
  // six-month monthly rate — a 25% saving for committing to the year.
  warehouse_starter_6mo: {
    key: 'warehouse_starter_6mo',
    label: 'Warehouse Starter — 6 months',
    companyType: 'warehouse',
    priceMinorUnits: 1800000, // Rs 18,000 total
    monthlyMinorUnits: 300000, // Rs 3,000/month
    durationMonths: 6,
    deliveryPersonnelLimit: 3,
    currency: 'PKR',
  },
  warehouse_starter_1yr: {
    key: 'warehouse_starter_1yr',
    label: 'Warehouse Starter — 1 year',
    companyType: 'warehouse',
    priceMinorUnits: 2700000, // Rs 27,000 total
    monthlyMinorUnits: 225000, // Rs 2,250/month — lower than 6mo
    durationMonths: 12,
    deliveryPersonnelLimit: 3,
    currency: 'PKR',
  },
  warehouse_growth_6mo: {
    key: 'warehouse_growth_6mo',
    label: 'Warehouse Growth — 6 months',
    companyType: 'warehouse',
    priceMinorUnits: 2400000, // Rs 24,000 total
    monthlyMinorUnits: 400000, // Rs 4,000/month
    durationMonths: 6,
    deliveryPersonnelLimit: 5,
    currency: 'PKR',
  },
  warehouse_growth_1yr: {
    key: 'warehouse_growth_1yr',
    label: 'Warehouse Growth — 1 year',
    companyType: 'warehouse',
    priceMinorUnits: 3600000, // Rs 36,000 total
    monthlyMinorUnits: 300000, // Rs 3,000/month — lower than 6mo
    durationMonths: 12,
    deliveryPersonnelLimit: 5,
    currency: 'PKR',
  },
  warehouse_scale_6mo: {
    key: 'warehouse_scale_6mo',
    label: 'Warehouse Scale — 6 months',
    companyType: 'warehouse',
    priceMinorUnits: 3600000, // Rs 36,000 total
    monthlyMinorUnits: 600000, // Rs 6,000/month
    durationMonths: 6,
    deliveryPersonnelLimit: 10,
    currency: 'PKR',
  },
  warehouse_scale_1yr: {
    key: 'warehouse_scale_1yr',
    label: 'Warehouse Scale — 1 year',
    companyType: 'warehouse',
    priceMinorUnits: 5400000, // Rs 54,000 total
    monthlyMinorUnits: 450000, // Rs 4,500/month — lower than 6mo
    durationMonths: 12,
    deliveryPersonnelLimit: 10,
    currency: 'PKR',
  },

  // ── Free trial (admin-approved) ─────────────────────────────────────────
  // Granted by a super-admin approving a kind='TRIAL' submission, never bought:
  // price 0 means getBankDetails/createSubmission refuse to take payment for
  // it, and companyType null means plansForType never offers it. Features come
  // from the company's type, so the trial runs the whole warehouse system; the
  // only restriction is ONE active delivery rider. Every plan on sale allows
  // more, so converting a trial to any paid plan never locks a rider.
  warehouse_trial: {
    key: 'warehouse_trial',
    label: 'Free trial — 30 days',
    companyType: null,
    priceMinorUnits: 0,
    monthlyMinorUnits: 0,
    durationMonths: null,
    durationDays: 30,
    deliveryPersonnelLimit: 1,
    currency: 'PKR',
  },
};

export const TRIAL_PLAN_KEY: TrialPlanKey = 'warehouse_trial';
/** The trial runs this many days from the moment it is APPROVED. */
export const TRIAL_DURATION_DAYS = PLAN_CONFIG.warehouse_trial.durationDays as number;

export function isTrialPlan(raw: string | null | undefined): boolean {
  return raw === TRIAL_PLAN_KEY;
}

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
  'warehouse_starter_6mo',
  'warehouse_starter_1yr',
  'warehouse_growth_6mo',
  'warehouse_growth_1yr',
  'warehouse_scale_6mo',
  'warehouse_scale_1yr',
  'warehouse_trial',
];

// Order matters: this is the order plans render in. Cheapest first within a
// type, so the ladder reads Starter → Growth → Scale.
//
// WAREHOUSE-ONLY BUILD: the small_business and large_org plans are commented
// out of the offering below. Their PLAN_CONFIG entries deliberately REMAIN
// (with companyType null) — Sukoon is on small_business_6mo and MetroMatrix
// on large_org_6mo, both paid up, and deleting the entries would make
// getPlanConfig() fall back to `free`, silently wiping their limits and
// expiry. Un-comment these four lines and restore their companyType values
// to sell those tiers again.
export const TIER_PLAN_KEYS: TierPlanKey[] = [
  // 'small_business_3mo',
  // 'small_business_6mo',
  // 'large_org_3mo',
  // 'large_org_6mo',
  'warehouse_starter_6mo',
  'warehouse_starter_1yr',
  'warehouse_growth_6mo',
  'warehouse_growth_1yr',
  'warehouse_scale_6mo',
  'warehouse_scale_1yr',
];

/**
 * The plans a company type may buy. Retired/legacy plans carry
 * `companyType: null` and are never returned — including for a company whose
 * own companyType is null, which must be offered nothing rather than matched
 * against every retired plan.
 */
export function plansForType(companyType: string | null | undefined): PlanConfig[] {
  if (!companyType) return [];
  return TIER_PLAN_KEYS.map((k) => withOverride(PLAN_CONFIG[k])).filter(
    (p) =>
      p.companyType !== null &&
      p.companyType === companyType &&
      // A retired plan stays resolvable for companies already on it, but is
      // not offered to anyone new.
      isPlanOffered(p.key),
  );
}


// ─── Admin overrides ─────────────────────────────────
/**
 * The fields an admin may change from the console.
 *
 * Deliberately narrow. Everything here is either a number a customer is
 * quoted, the one limit the platform actually enforces, or display text:
 *
 *   monthlyMinorUnits / priceMinorUnits  what the customer is charged
 *   deliveryPersonnelLimit               the only plan difference enforced
 *   label                                display only
 *   isOffered                            whether it is sold to anyone new
 *
 * What is NOT editable, and why:
 *
 *   key            it is the primary key, stored on every company row
 *   durationMonths the key says `_6mo`; changing the number makes it lie,
 *                  and existing subscriptions were sold against the old one
 *   companyType    moves the plan to a different tier ladder
 *   currency       would silently reprice every past quote
 */
export interface PlanOverridePatch {
  label?: string;
  monthlyMinorUnits?: number;
  priceMinorUnits?: number;
  deliveryPersonnelLimit?: number;
  isOffered?: boolean;
}

/**
 * Overrides live in a module-level map rather than being threaded through
 * every consumer.
 *
 * getPlanConfig() is the single resolution point for billing, auth, companies
 * and delivery-personnel, and all of them call it SYNCHRONOUSLY. Making the
 * catalogue database-backed by making those call sites async would have meant
 * changing four modules, including the price-on-submit path. Merging here
 * instead means every existing caller picks up an admin's edit with no change
 * at all.
 *
 * PlanOverrideService owns this map: it loads the table at boot and re-loads
 * it after every write. Nothing else may write to it.
 */
const PLAN_OVERRIDES = new Map<PlanKey, PlanOverridePatch>();

/** Replaces the whole set. Called by PlanOverrideService only. */
export function loadPlanOverrides(entries: Iterable<[PlanKey, PlanOverridePatch]>): void {
  PLAN_OVERRIDES.clear();
  for (const [key, patch] of entries) PLAN_OVERRIDES.set(key, patch);
}

/** The raw override for a plan, or undefined. For the admin editor's "reset". */
export function getPlanOverride(key: PlanKey): PlanOverridePatch | undefined {
  return PLAN_OVERRIDES.get(key);
}

/** Whether a plan is still sold. An override may retire one without deleting it. */
export function isPlanOffered(key: PlanKey): boolean {
  return PLAN_OVERRIDES.get(key)?.isOffered !== false;
}

function withOverride(base: PlanConfig): PlanConfig {
  const patch = PLAN_OVERRIDES.get(base.key);
  if (!patch) return base;
  return {
    ...base,
    label: patch.label ?? base.label,
    monthlyMinorUnits: patch.monthlyMinorUnits ?? base.monthlyMinorUnits,
    priceMinorUnits: patch.priceMinorUnits ?? base.priceMinorUnits,
    deliveryPersonnelLimit:
      patch.deliveryPersonnelLimit ?? base.deliveryPersonnelLimit,
  };
}

export function isPlanKey(v: unknown): v is PlanKey {
  return typeof v === 'string' && (PLAN_KEYS as string[]).includes(v);
}

export function normalizePlan(raw: string | null | undefined): PlanKey {
  return isPlanKey(raw) ? raw : 'free';
}

export function getPlanConfig(raw: string | null | undefined): PlanConfig {
  return withOverride(PLAN_CONFIG[normalizePlan(raw)]);
}

/** Every plan in the catalogue, admin edits applied, in config order. */
export function allPlanConfigs(): PlanConfig[] {
  return TIER_PLAN_KEYS.map((k) => withOverride(PLAN_CONFIG[k]));
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
