import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request } from 'express';
import { DataSource } from 'typeorm';
import { AuthenticatedUser } from '../decorators/current-user.decorator';
import { FEATURE_KEY } from './requires-feature.decorator';
import { computeFeatures, FeatureKey } from './feature-map';

/**
 * Server-side tier enforcement (FinMatrix.md Phase 1 §3). Reads the feature
 * area declared by @RequiresFeature and the company's row (type, inventory
 * toggle, kill switch), and 403s when the tier doesn't include the feature.
 *
 * - Same lightweight indexed-lookup pattern as CompanyGuard; self-contained
 *   so guard ordering can't break it.
 * - The kill switch (all_features_unlocked / FEATURES_DISABLED env) is
 *   resolved inside computeFeatures BEFORE any type check — flipping it
 *   restores access without a deploy.
 * - Routes without @RequiresFeature are untouched (accounting core is never
 *   gated).
 */
@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly dataSource: DataSource,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const feature = this.reflector.getAllAndOverride<FeatureKey | undefined>(FEATURE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!feature) return true;

    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser; companyId?: string | null }>();
    const companyId = req.companyId ?? req.user?.companyId ?? null;
    if (!companyId) {
      // No tenant context — let CompanyGuard's own error surface instead.
      throw new ForbiddenException({
        code: 'NOT_COMPANY_MEMBER',
        message: 'You must belong to a company to access this resource.',
      });
    }

    const rows: Array<{
      company_type: string | null;
      inventory_enabled: boolean | null;
      all_features_unlocked: boolean | null;
    }> = await this.dataSource.query(
      `SELECT company_type, inventory_enabled, all_features_unlocked FROM companies WHERE id = $1 LIMIT 1`,
      [companyId],
    );
    const row = rows[0];
    const features = computeFeatures({
      companyType: row?.company_type ?? null,
      inventoryEnabled: row?.inventory_enabled ?? false,
      allFeaturesUnlocked: row?.all_features_unlocked ?? false,
    });

    if (!features[feature]) {
      throw new ForbiddenException({
        code: 'FEATURE_NOT_AVAILABLE',
        message: `Your plan does not include this feature (${feature}). Upgrade your company type to use it.`,
        feature,
      });
    }
    return true;
  }
}
