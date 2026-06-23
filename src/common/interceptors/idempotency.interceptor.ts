import {
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Observable, of } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { IdempotencyRecord } from './idempotency-record.entity';

/**
 * Idempotency for mutating POSTs (FinMatrixGuide §6.3).
 *
 * When a POST carries an `Idempotency-Key` header, the first request runs
 * normally and its (enveloped) response is stored keyed by (company, key). A
 * retry with the same key returns the stored response instead of executing the
 * handler again — so a double-tap / network retry can never double-post.
 *
 * Registered BEFORE the response-envelope interceptor so it is the OUTER
 * interceptor: it captures (and replays) the fully-enveloped client response.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(
    @InjectRepository(IdempotencyRecord)
    private readonly repo: Repository<IdempotencyRecord>,
  ) {}

  async intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest();
    const res = context.switchToHttp().getResponse();
    const key: string | undefined =
      req.headers['idempotency-key'] || req.headers['x-idempotency-key'];

    if (req.method !== 'POST' || !key) {
      return next.handle();
    }

    const companyId: string =
      req.companyId || req.user?.companyId || req.headers['x-company-id'] || 'no-company';
    const path: string = (req.originalUrl || req.url || '').split('?')[0];

    const existing = await this.repo.findOne({
      where: { companyId, idempotencyKey: key },
    });
    if (existing) {
      if (existing.status === 'completed') {
        if (existing.statusCode) res.status(existing.statusCode);
        return of(existing.responseBody);
      }
      // A request with this key is still in flight.
      throw new ConflictException({
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'A request with this Idempotency-Key is already being processed',
      });
    }

    // Reserve the key. The unique (company, key) index makes this the race
    // arbiter: if a concurrent request already reserved it, our insert throws.
    try {
      await this.repo.insert({
        companyId,
        idempotencyKey: key,
        method: req.method,
        path: path.slice(0, 300),
        status: 'pending',
      });
    } catch {
      const now = await this.repo.findOne({
        where: { companyId, idempotencyKey: key },
      });
      if (now?.status === 'completed') {
        if (now.statusCode) res.status(now.statusCode);
        return of(now.responseBody);
      }
      throw new ConflictException({
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message: 'A request with this Idempotency-Key is already being processed',
      });
    }

    return next.handle().pipe(
      tap(async (body) => {
        await this.repo.update(
          { companyId, idempotencyKey: key },
          {
            status: 'completed',
            statusCode: res.statusCode ?? 200,
            responseBody: body ?? null,
          },
        );
      }),
      catchError(async (err) => {
        // The handler failed — release the reservation so the client can retry.
        await this.repo
          .delete({ companyId, idempotencyKey: key })
          .catch(() => undefined);
        throw err;
      }),
    );
  }
}
