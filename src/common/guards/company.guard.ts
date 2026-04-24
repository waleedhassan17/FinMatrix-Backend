import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../decorators/current-user.decorator';

/**
 * Extracts companyId from the authenticated user (JWT) and attaches it to
 * request.companyId so services can filter all queries by tenant.
 */
@Injectable()
export class CompanyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
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
    req.companyId = companyId;
    return true;
  }
}
