import { computeFeatures, FEATURE_KEYS } from './feature-map';

describe('FEATURE_MAP / computeFeatures (FinMatrix.md THE MODEL)', () => {
  const base = { inventoryEnabled: false, allFeaturesUnlocked: false };

  it('small_business: accounting extras only — no inventory/delivery/payroll/budgets/multiUser', () => {
    const f = computeFeatures({ ...base, companyType: 'small_business' });
    expect(f.estimates).toBe(true);
    expect(f.journalEntries).toBe(true);
    expect(f.creditMemos).toBe(true);
    expect(f.bankReconciliation).toBe(true); // core feature, all tiers (phase3.md)
    for (const k of [
      'inventory', 'purchaseOrders', 'salesOrders', 'agencies', 'delivery',
      'payroll', 'budgets', 'multiUser', 'auditLog', 'periodClose',
    ] as const) {
      expect(f[k]).toBe(false);
    }
  });

  it('large_org: payroll/budgets/multiUser/auditLog/periodClose/bankRec on; inventory, delivery & PO/GRNI NEVER', () => {
    const f = computeFeatures({ ...base, companyType: 'large_org' });
    for (const k of ['payroll', 'budgets', 'multiUser', 'auditLog', 'periodClose', 'bankReconciliation'] as const) {
      expect(f[k]).toBe(true);
    }
    expect(f.inventory).toBe(false); // warehouse-only
    expect(f.delivery).toBe(false);
    expect(f.purchaseOrders).toBe(false);
  });

  it('large_org: the per-company inventory toggle no longer unlocks anything (warehouse-only)', () => {
    const f = computeFeatures({ companyType: 'large_org', inventoryEnabled: true, allFeaturesUnlocked: false });
    expect(f.inventory).toBe(false);
    expect(f.delivery).toBe(false);
    expect(f.purchaseOrders).toBe(false);
    expect(f.salesOrders).toBe(false);
  });

  it('warehouse: everything on (inventory regardless of the toggle)', () => {
    const f = computeFeatures({ ...base, companyType: 'warehouse' });
    for (const k of FEATURE_KEYS) expect(f[k]).toBe(true);
  });

  it('KILL SWITCH beats the type check (checked first, SAFETY §4)', () => {
    const f = computeFeatures({ companyType: 'small_business', inventoryEnabled: false, allFeaturesUnlocked: true });
    for (const k of FEATURE_KEYS) expect(f[k]).toBe(true);
  });

  it('legacy company with no type is fully unlocked (never lock out existing customers)', () => {
    const f = computeFeatures({ companyType: null, inventoryEnabled: false, allFeaturesUnlocked: false });
    for (const k of FEATURE_KEYS) expect(f[k]).toBe(true);
  });

  it('global FEATURES_DISABLED env is an app-wide kill switch', () => {
    process.env.FEATURES_DISABLED = 'true';
    try {
      const f = computeFeatures({ companyType: 'small_business', inventoryEnabled: false, allFeaturesUnlocked: false });
      for (const k of FEATURE_KEYS) expect(f[k]).toBe(true);
    } finally {
      delete process.env.FEATURES_DISABLED;
    }
  });
});
