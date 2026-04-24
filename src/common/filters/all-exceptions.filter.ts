import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Request, Response } from 'express';

interface ErrorEnvelope {
  success: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

/**
 * Maps exceptions into the unified error envelope.
 * Supports throwing NestJS HttpExceptions where the response body is either:
 *   - a string: treated as the message
 *   - an object: { code?: string, message?: string, details?: unknown }
 */
@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code = 'INTERNAL_ERROR';
    let message = 'An unexpected error occurred';
    let details: unknown;

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();

      if (typeof body === 'string') {
        message = body;
      } else if (body && typeof body === 'object') {
        const b = body as Record<string, unknown>;
        message =
          (typeof b.message === 'string' ? b.message : undefined) ??
          (Array.isArray(b.message) ? (b.message as string[]).join('; ') : undefined) ??
          message;
        code = typeof b.code === 'string' ? b.code : this.defaultCodeForStatus(status);
        if (b.details !== undefined) details = b.details;
        if (Array.isArray(b.message)) details = { fields: b.message };
      } else {
        code = this.defaultCodeForStatus(status);
      }
    } else if (exception instanceof Error) {
      message = exception.message;
      this.logger.error(exception.stack ?? exception.message);
    } else {
      this.logger.error(`Non-Error thrown: ${JSON.stringify(exception)}`);
    }

    const envelope: ErrorEnvelope = {
      success: false,
      error: {
        code,
        message,
        ...(details !== undefined ? { details } : {}),
      },
    };

    if (status >= 500) {
      this.logger.error(
        `[${req.method}] ${req.url} -> ${status} ${code}: ${message}`,
      );
    }

    res.status(status).json(envelope);
  }

  private defaultCodeForStatus(status: number): string {
    switch (status) {
      case HttpStatus.BAD_REQUEST:
        return 'VALIDATION_FAILED';
      case HttpStatus.UNAUTHORIZED:
        return 'UNAUTHORIZED';
      case HttpStatus.FORBIDDEN:
        return 'FORBIDDEN';
      case HttpStatus.NOT_FOUND:
        return 'NOT_FOUND';
      case HttpStatus.TOO_MANY_REQUESTS:
        return 'RATE_LIMIT';
      default:
        return 'INTERNAL_ERROR';
    }
  }
}
