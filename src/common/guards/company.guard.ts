import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { DataSource } from 'typeorm';
import { AuthenticatedUser } from '../decorators/current-user.decorator';
import {
  effectiveCompanyStatus,
  normalizeCompanyStatus,
} from '../utils/company-status.util';

/**
 * Extracts companyId from the authenticated user (JWT), enforces that the
 * company is ACTIVE (Phase1.md server-side gate), and attaches companyId to the
 * request so services can filter all queries by tenant.
 *
 * The status check is a lightweight indexed lookup and makes deactivation take
 * effect immediately — a pending/inactive/rejected company's token cannot reach
 * any business endpoint even if signin was somehow bypassed.
 */
@Injectable()
export class CompanyGuard implements CanActivate {
  constructor(private readonly dataSource: DataSource) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser; companyId?: string | null }>();

    const companyId = req.user?.companyId ?? null;
    if (!companyId) {
      throw new ForbiddenException({
        code: 'NOT_COMPANY_MEMBER',
        message: 'You must belong to a company to access this resource.',
      });
    }

    const rows: Array<{
      status: string | null;
      subscription_plan: string | null;
      subscription_expiry_date: Date | null;
    }> = await this.dataSource.query(
      `SELECT status, subscription_plan, subscription_expiry_date
         FROM companies WHERE id = $1 LIMIT 1`,
      [companyId],
    );
    // effectiveCompanyStatus applies the LIVE subscription-expiry check, so a
    // paid plan is cut off the moment it lapses — not at the next 1AM billing
    // cron (which persists status='inactive' and sends the notification).
    const row = rows[0];
    const acctStatus = effectiveCompanyStatus(
      row
        ? {
            status: row.status,
            subscriptionPlan: row.subscription_plan,
            subscriptionExpiryDate: row.subscription_expiry_date,
          }
        : null,
    );
    if (acctStatus !== 'active') {
      const subscriptionLapsed =
        row != null &&
        normalizeCompanyStatus(row.status) === 'active' &&
        acctStatus === 'inactive';
      throw new ForbiddenException({
        code: 'COMPANY_NOT_ACTIVE',
        message:
          acctStatus === 'rejected'
            ? 'Your company registration was rejected.'
            : acctStatus === 'inactive'
              ? subscriptionLapsed
                ? 'Your subscription has expired. Renew your plan to restore access.'
                : 'Your company account has been deactivated.'
              : 'Your company is awaiting approval.',
        companyStatus: acctStatus,
      });
    }

    req.companyId = companyId;
    return true;
  }
}
