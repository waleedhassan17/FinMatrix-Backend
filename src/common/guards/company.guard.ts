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
import { RIDER_SEAT_LOCKED_MESSAGE } from '../../modules/delivery-personnel/rider-seats';
import { assertEmailVerified } from '../utils/email-verified.util';

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
      .getRequest<
        Request & { user?: AuthenticatedUser; companyId?: string | null }
      >();

    // Before anything company-shaped: an unverified owner holds a session only
    // so they can wait on the verify screen, never to use the books.
    assertEmailVerified(req.user);

    const companyId = req.user?.companyId ?? null;
    if (!companyId) {
      throw new ForbiddenException({
        code: 'NOT_COMPANY_MEMBER',
        message: 'You must belong to a company to access this resource.',
      });
    }

    // Membership is read live, in the same lookup. The token's companyId and
    // role are only what was true when it was issued: a member who has since
    // been removed used to keep reaching the company's books, and a demoted
    // admin kept admin, until the token (and every refresh of it) expired.
    //
    // Riders also carry their seat status: a rider the plan no longer covers
    // (`plan_locked`, see delivery-personnel/rider-seats.ts) is refused on
    // every request, not only at sign-in. Still one query per request.
    const isRider = req.user?.role === 'delivery';
    const rows: Array<{
      status: string | null;
      subscription_plan: string | null;
      subscription_expiry_date: Date | null;
      member_role: string | null;
      rider_status?: string | null;
    }> = isRider
      ? await this.dataSource.query(
          `SELECT c.status, c.subscription_plan, c.subscription_expiry_date,
                  uc.role AS member_role, p.status AS rider_status
             FROM companies c
             LEFT JOIN user_companies uc
               ON uc.company_id = c.id AND uc.user_id = $2
             LEFT JOIN delivery_personnel_profiles p
               ON p.company_id = c.id AND p.user_id = $2
            WHERE c.id = $1 LIMIT 1`,
          [companyId, req.user?.id],
        )
      : await this.dataSource.query(
          `SELECT c.status, c.subscription_plan, c.subscription_expiry_date,
                  uc.role AS member_role
             FROM companies c
             LEFT JOIN user_companies uc
               ON uc.company_id = c.id AND uc.user_id = $2
            WHERE c.id = $1 LIMIT 1`,
          [companyId, req.user?.id],
        );
    const row = rows[0];
    if (row && !row.member_role) {
      throw new ForbiddenException({
        code: 'NOT_COMPANY_MEMBER',
        message: 'You are no longer a member of this company.',
      });
    }

    // effectiveCompanyStatus applies the LIVE subscription-expiry check, so a
    // paid plan is cut off the moment it lapses — not at the next 1AM billing
    // cron (which persists status='inactive' and sends the notification).
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
              : // A draft has not been submitted, so "awaiting approval" would
                // describe work the user has not done yet.
                acctStatus === 'draft'
                ? 'Finish setting up your company to continue.'
                : 'Your company is awaiting approval.',
        companyStatus: acctStatus,
      });
    }

    if (isRider && row?.rider_status === 'plan_locked') {
      throw new ForbiddenException({
        code: 'RIDER_SEAT_LOCKED',
        message: RIDER_SEAT_LOCKED_MESSAGE,
      });
    }

    // RolesGuard runs after this guard on every controller, and services read
    // the same req.user, so both now see the member's current role.
    if (req.user && row?.member_role) {
      req.user.role = row.member_role as AuthenticatedUser['role'];
    }
    req.companyId = companyId;
    return true;
  }
}
