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
