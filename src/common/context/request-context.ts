import { AsyncLocalStorage } from 'async_hooks';
import { Request } from 'express';
import { AuthenticatedUser } from '../decorators/current-user.decorator';

export type AuditRequest = Request & {
  user?: AuthenticatedUser;
  companyId?: string | null;
};

export interface RequestContext {
  /**
   * The live request object, not a snapshot of its fields.
   *
   * Middleware runs BEFORE guards in Nest's pipeline, so at the moment we open
   * this scope `req.user` and `req.companyId` do not exist yet — JwtAuthGuard
   * and CompanyGuard set them a step later. Holding the request itself means
   * anything reading the context during the handler (the audit subscriber,
   * flushing after commit) sees the populated values.
   */
  req: AuditRequest;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Run `fn` with `req` as the ambient request context. */
export function runWithRequestContext<T>(req: AuditRequest, fn: () => T): T {
  return storage.run({ req }, fn);
}

/**
 * The acting user, company and client details for the in-flight request.
 *
 * Returns nulls outside a request — scheduled jobs, queue workers and seed
 * scripts have no HTTP context. Callers record a system actor rather than
 * failing; see FinancialAuditSubscriber.
 */
export function currentActor(): {
  userId: string | null;
  companyId: string | null;
  ipAddress: string | null;
  userAgent: string | null;
} {
  const req = storage.getStore()?.req;
  if (!req) {
    return { userId: null, companyId: null, ipAddress: null, userAgent: null };
  }
  return {
    userId: req.user?.id ?? null,
    companyId: req.companyId ?? req.user?.companyId ?? null,
    ipAddress: req.ip ?? null,
    userAgent: (req.headers?.['user-agent'] as string | undefined) ?? null,
  };
}
