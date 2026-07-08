import { SetMetadata } from '@nestjs/common';
import { FeatureKey } from './feature-map';

export const FEATURE_KEY = 'requiresFeature';

/**
 * Declares which feature area a controller (or a single route) belongs to.
 * Enforced by FeatureGuard: companies whose tier doesn't include the feature
 * get 403 FEATURE_NOT_AVAILABLE. Apply at class level for whole modules
 * (deliveries, payroll, …) or at method level for mixed controllers
 * (e.g. the team-management routes inside settings).
 */
export const RequiresFeature = (feature: FeatureKey) => SetMetadata(FEATURE_KEY, feature);
