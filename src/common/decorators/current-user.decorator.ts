import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export interface AuthenticatedUser {
  id: string;
  /** Null for owner-created accounts, which sign in by username. */
  email: string | null;
  username: string | null;
  role: 'admin' | 'delivery' | 'staff' | 'super_admin';
  companyId: string | null;
  /**
   * False only for an owner whose email address is not confirmed yet. Such a
   * session exists (signup and sign-in both issue one, so the client can wait
   * on the verify screen and move on by itself), but it may do nothing else —
   * see assertEmailVerified. Optional so a user built elsewhere (tests, other
   * strategies) is treated as verified rather than locked out.
   */
  emailVerified?: boolean;
}

export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);
