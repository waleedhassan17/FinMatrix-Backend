import { EntityManager } from 'typeorm';
import { computeFeatures, FeatureKey } from './feature-map';

/**
 * The feature map for one company, read inside the caller's transaction.
 *
 * FeatureGuard answers "may this route be called at all". Some business rules
 * also depend on the tier — a company that tracks inventory must pick stock
 * items on its documents, one that doesn't keeps free-text lines — and those
 * rules live in services, so they need the same lookup.
 */
export async function companyFeatures(
  manager: EntityManager,
  companyId: string,
): Promise<Record<FeatureKey, boolean>> {
  const rows: Array<{
    company_type: string | null;
    inventory_enabled: boolean | null;
    all_features_unlocked: boolean | null;
  }> = await manager.query(
    `SELECT company_type, inventory_enabled, all_features_unlocked FROM companies WHERE id = $1 LIMIT 1`,
    [companyId],
  );
  const row = rows[0];
  return computeFeatures({
    companyType: row?.company_type ?? null,
    inventoryEnabled: row?.inventory_enabled ?? false,
    allFeaturesUnlocked: row?.all_features_unlocked ?? false,
  });
}
