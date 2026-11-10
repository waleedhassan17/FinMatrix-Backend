import {
  BadRequestException,
  CallHandler,
  ConflictException,
  ExecutionContext,
  Injectable,
  Logger,
  NestInterceptor,
  UnprocessableEntityException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import { Observable, of } from 'rxjs';
import { catchError, concatMap } from 'rxjs/operators';
import { IdempotencyRecord } from './idempotency-record.entity';

/** Matches the idempotency_key column. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/**
 * A reservation older than this belongs to a request that never finished (the
 * process died mid-flight). Without a cut-off its key stayed "in progress"
 * forever and every retry with it got a 409.
 */
export const IDEMPOTENCY_PENDING_STALE_MS = 5 * 60_000;

/**
 * Idempotency for mutating POSTs (FinMatrixGuide §6.3).
 *
 * When a POST carries an `Idempotency-Key` header, the first request runs
 * normally and its (enveloped) response is stored keyed by (scope, key). A
 * retry with the same key returns the stored response instead of executing the
 * handler again — so a double-tap / network retry can never double-post.
 *
 * The scope is the caller's company, or the caller themselves before they have
 * one (onboarding). It is never taken from a request header: the client
 * cannot choose whose stored responses it is replayed.
 *
 * Registered BEFORE the response-envelope interceptor so it is the OUTER
 * interceptor: it captures (and replays) the fully-enveloped client response.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  private readonly logger = new Logger(IdempotencyInterceptor.name);

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
    const rawKey =
      req.headers['idempotency-key'] ?? req.headers['x-idempotency-key'];
    const key: string | undefined =
      typeof rawKey === 'string' ? rawKey.trim() : undefined;

    if (req.method !== 'POST' || !key) {
      return next.handle();
    }

    // Public routes have no caller to scope a key to, so they are not
    // deduplicated (they include sign-in and sign-up, which must not replay).
    const scope: string | undefined =
      req.companyId || req.user?.companyId || req.user?.id;
    if (!scope) {
      return next.handle();
    }

    if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new BadRequestException({
        code: 'IDEMPOTENCY_KEY_INVALID',
        message: `Idempotency-Key must be at most ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`,
      });
    }

    const method: string = req.method;
    const path: string = (req.originalUrl || req.url || '')
      .split('?')[0]
      .slice(0, 300);
    const where = { companyId: scope, idempotencyKey: key };

    // Release a reservation abandoned by a request that never finished.
    await this.repo.delete({
      ...where,
      status: 'pending',
      createdAt: LessThan(new Date(Date.now() - IDEMPOTENCY_PENDING_STALE_MS)),
    });

    const existing = await this.repo.findOne({ where });
    if (existing) {
      return this.replay(existing, method, path, res);
    }

    // Reserve the key. The unique (scope, key) index makes this the race
    // arbiter: if a concurrent request already reserved it, our insert throws.
    try {
      await this.repo.insert({ ...where, method, path, status: 'pending' });
    } catch {
      const now = await this.repo.findOne({ where });
      if (now) return this.replay(now, method, path, res);
      throw new ConflictException({
        code: 'IDEMPOTENCY_IN_PROGRESS',
        message:
          'A request with this Idempotency-Key is already being processed',
      });
    }

    return next.handle().pipe(
      // Record the outcome BEFORE the response goes out, so a retry that
      // arrives right after it replays instead of meeting "in progress". A
      // failure to record is logged, never thrown: the work is done and the
      // client must get its answer.
      concatMap(async (body) => {
        try {
          await this.repo.update(where, {
            status: 'completed',
            statusCode: res.statusCode ?? 200,
            responseBody: body ?? null,
          });
        } catch (err) {
          this.logger.error(
            `could not record idempotent response for ${method} ${path}: ${(err as Error).message}`,
          );
        }
        return body;
      }),
      catchError(async (err) => {
        // The handler failed — release the reservation so the client can retry.
        await this.repo.delete(where).catch(() => undefined);
        throw err;
      }),
    );
  }

  /** Answer from a stored record, or explain why it cannot be. */
  private replay(
    record: IdempotencyRecord,
    method: string,
    path: string,
    res: { status: (code: number) => unknown },
  ): Observable<unknown> {
    // The same key sent to a different endpoint is a client bug; replaying
    // the other endpoint's response would report success for work never done.
    if (record.method !== method || record.path !== path) {
      throw new UnprocessableEntityException({
        code: 'IDEMPOTENCY_KEY_REUSED',
        message:
          'This Idempotency-Key was already used for a different request',
      });
    }
    if (record.status === 'completed') {
      if (record.statusCode) res.status(record.statusCode);
      return of(record.responseBody);
    }
    throw new ConflictException({
      code: 'IDEMPOTENCY_IN_PROGRESS',
      message: 'A request with this Idempotency-Key is already being processed',
    });
  }
}
