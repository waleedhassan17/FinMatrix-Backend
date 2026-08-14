import { Injectable, NestMiddleware } from '@nestjs/common';
import { Response, NextFunction } from 'express';
import { AuditRequest, runWithRequestContext } from './request-context';

/**
 * Opens the AsyncLocalStorage scope that carries the acting user and company
 * down to the data layer, where TypeORM subscribers have no other way to know
 * who is making a change.
 *
 * Registered first in AppModule.configure so every downstream handler — and
 * every promise it awaits — runs inside the scope.
 */
@Injectable()
export class RequestContextMiddleware implements NestMiddleware {
  use(req: AuditRequest, _res: Response, next: NextFunction) {
    runWithRequestContext(req, () => next());
  }
}
