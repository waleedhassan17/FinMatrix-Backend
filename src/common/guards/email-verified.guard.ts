import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../decorators/current-user.decorator';
import { assertEmailVerified } from '../utils/email-verified.util';

/**
 * Refuses an unverified owner's session (see assertEmailVerified).
 *
 * For the routes CompanyGuard does not cover because they run before a company
 * exists or is active: creating, joining and submitting one. Must run after
 * JwtAuthGuard, which is what puts `emailVerified` on the request.
 */
@Injectable()
export class EmailVerifiedGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    assertEmailVerified(req.user);
    return true;
  }
}
