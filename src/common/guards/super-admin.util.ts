import { ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../decorators/current-user.decorator';

/**
 * Platform super-admin only. The role comes from the token; a super-admin
 * never carries a companyId, so a company admin's token can never pass.
 * (The older controllers each keep a private copy of this check.)
 */
export function assertSuperAdmin(user: AuthenticatedUser | undefined): void {
  if (user?.role !== 'super_admin') {
    throw new ForbiddenException({
      code: 'SUPER_ADMIN_REQUIRED',
      message: 'Super admin access required',
    });
  }
}
