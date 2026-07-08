/**
 * FinMatrix.md — THE MODEL. Single server-side source of truth for which
 * feature areas each company type can reach. The accounting core (ledger /
 * posting engine, invoices, bills, payments, reports) is NEVER gated — it has
 * no entry here on purpose; only the optional feature areas do.
 *
 * Gating is enforced at the controller boundary by FeatureGuard +
 * @RequiresFeature(...) — never inside business logic, so the posting engine
 * stays untouched.
 */

export type CompanyType = 'small_business' | 'large_org' | 'warehouse';

export const COMPANY_TYPES: CompanyType[] = ['small_business', 'large_org', 'warehouse'];

export function isCompanyType(v: unknown): v is CompanyType {
  return typeof v === 'string' && (COMPANY_TYPES as string[]).includes(v);
}

/** Feature areas that can be switched off for a tier. */
export type FeatureKey =
  | 'estimates'
  | 'journalEntries'
  | 'creditMemos' // customer credit memos + vendor credits (accounting corrections)
  | 'bankReconciliation'
  | 'multiUser' // team management / invites / roles
  | 'auditLog'
  | 'periodClose'
  | 'payroll' // employees + payroll runs
  | 'budgets'
  | 'inventory' // stock, adjustments, valuation
  | 'purchaseOrders' // PO → GRNI 3-way match
  | 'salesOrders'
  | 'agencies'
  | 'delivery'; // deliveries + delivery personnel + approvals + shadow inventory

/**
 * 'toggle' = decided by the company's own inventory_enabled flag (the
 * large-organization per-company inventory option from THE MODEL).
 */
type FeatureSetting = boolean | 'toggle';

export const FEATURE_MAP: Record<CompanyType, Record<FeatureKey, FeatureSetting>> = {
  small_business: {
    estimates: true,
    journalEntries: true,
    creditMemos: true,
    bankReconciliation: false,
    multiUser: false,
    auditLog: false,
    periodClose: false,
    payroll: false,
    budgets: false,
    inventory: false,
    purchaseOrders: false,
    salesOrders: false,
    agencies: false,
    delivery: false,
  },
  large_org: {
    estimates: true,
    journalEntries: true,
    creditMemos: true,
    bankReconciliation: true,
    multiUser: true,
    auditLog: true,
    periodClose: true,
    payroll: true,
    budgets: true,
    inventory: 'toggle', // per-company opt-in (basic stock + COGS only)
    purchaseOrders: false, // no PO/GRNI even with inventory toggled on
    salesOrders: false,
    agencies: false,
    delivery: false, // never, even with inventory on
  },
  warehouse: {
    estimates: true,
    journalEntries: true,
    creditMemos: true,
    bankReconciliation: true,
    multiUser: true,
    auditLog: true,
    periodClose: true,
    payroll: true,
    budgets: true,
    inventory: true,
    purchaseOrders: true,
    salesOrders: true,
    agencies: true,
    delivery: true,
  },
};

export const FEATURE_KEYS = Object.keys(FEATURE_MAP.warehouse) as FeatureKey[];

export interface CompanyFeatureSource {
  companyType: string | null;
  inventoryEnabled: boolean;
  allFeaturesUnlocked: boolean;
}

/**
 * Resolve the effective feature set for a company.
 *
 * Order matters (SAFETY §4): the kill switch — the company row's
 * all_features_unlocked or the global FEATURES_DISABLED env — is checked
 * BEFORE any type/plan logic, so flipping it restores full access instantly.
 * A company with no companyType yet (pre-tiering row that somehow missed the
 * migration default) is treated as fully unlocked: existing customers can
 * never lose access because of a missing value.
 */
export function computeFeatures(src: CompanyFeatureSource): Record<FeatureKey, boolean> {
  const unlockAll =
    src.allFeaturesUnlocked ||
    process.env.FEATURES_DISABLED === 'true' ||
    !isCompanyType(src.companyType);

  const result = {} as Record<FeatureKey, boolean>;
  if (unlockAll) {
    for (const k of FEATURE_KEYS) result[k] = true;
    return result;
  }

  const map = FEATURE_MAP[src.companyType as CompanyType];
  for (const k of FEATURE_KEYS) {
    const setting = map[k];
    result[k] = setting === 'toggle' ? src.inventoryEnabled : setting;
  }
  return result;
}
