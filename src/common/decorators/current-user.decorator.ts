import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';

export interface AuthenticatedUser {
  id: string;
  /** Null for owner-created accounts, which sign in by username. */
  email: string | null;
  username: string | null;
  role: 'admin' | 'delivery' | 'staff' | 'super_admin';
  companyId: string | null;
}

export const CurrentUser = createParamDecorator(
  (data: keyof AuthenticatedUser | undefined, ctx: ExecutionContext) => {
    const req = ctx.switchToHttp().getRequest<Request & { user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) return undefined;
    return data ? user[data] : user;
  },
);
