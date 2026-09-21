import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

export interface SuccessEnvelope<T> {
  success: true;
  data: T;
  message?: string;
}

/**
 * Wraps every successful controller response in the standard envelope:
 *   { success: true, data: <payload>, message?: string }
 *
 * If a handler already returns an object shaped like { data, message }
 * it is used as-is; otherwise the raw return value becomes `data`.
 *
 * Streaming responses (e.g. PDF) are skipped — any handler that sets the
 * Content-Type header to something other than application/json should
 * bypass this interceptor by writing directly to `res`.
 */
@Injectable()
export class ResponseEnvelopeInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<SuccessEnvelope<unknown>> {
    return next.handle().pipe(
      map((payload: unknown) => {
        if (
          payload &&
          typeof payload === 'object' &&
          'success' in (payload as Record<string, unknown>)
        ) {
          return payload as SuccessEnvelope<unknown>;
        }

        // A handler that already shaped its own `{ data, message }` is passed
        // through rather than nested one level deeper.
        //
        // ⚠ THIS BRANCH DISCARDS EVERY OTHER KEY. A handler returning
        // `{ data, total, page }` — or any object that happens to carry a
        // `data` field — arrives at the client as a bare `data` value with the
        // siblings silently gone. That is not hypothetical: the P&L drill-down
        // shipped returning its rows under `data` alongside `lineAmount` and
        // `total`, and every client rendered "no transactions" for months
        // because the array replaced the object it was supposed to sit inside.
        //
        // If a response needs metadata beside its rows, name the rows
        // something else — `entries`, `rows`, `items`. And test it over HTTP:
        // a service-level unit test never runs this interceptor, which is
        // precisely why that bug was invisible.
        if (
          payload &&
          typeof payload === 'object' &&
          'data' in (payload as Record<string, unknown>)
        ) {
          const p = payload as { data: unknown; message?: string };
          return {
            success: true,
            data: p.data,
            ...(p.message ? { message: p.message } : {}),
          };
        }

        return { success: true, data: payload };
      }),
    );
  }
}
