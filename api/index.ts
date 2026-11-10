/**
 * Vercel serverless entry point for the FinMatrix NestJS backend.
 *
 * Vercel runs each request through a (possibly cold) lambda. We bootstrap the
 * Nest application once per warm instance and cache it, then hand the raw
 * Node req/res to the underlying Express instance for every subsequent call.
 *
 * `src/main.ts` is used for local/dev (`npm run start:dev`) and every
 * long-running host (Heroku, ECS); this file only exists for the Vercel
 * runtime. Both share the HTTP pipeline in `src/app.setup.ts`.
 *
 * Note: scheduled work (@Cron / @Interval) does not run reliably on a
 * serverless instance that is frozen between requests.
 */
// Sentry must initialise before anything else is loaded.
import '../src/instrument';
import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'http';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as Sentry from '@sentry/nestjs';

type RequestListener = (req: IncomingMessage, res: ServerResponse) => void;

const logger = new Logger('VercelEntry');
let handlerPromise: Promise<RequestListener> | null = null;

async function bootstrap(): Promise<RequestListener> {
  // Lazy imports so a module-load error (missing dep, decorator failure) is
  // caught by the handler's try/catch instead of crashing the whole function.
  const { AppModule } = await import('../src/app.module');
  const { configureHttpApp } = await import('../src/app.setup');

  // Nest's own Express adapter (Express 4). A separately created Express 5
  // app was used here before, which Nest 10 does not support.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // Pino's buffered logger does not fit the serverless lifecycle; the default
    // Nest logger writes straight to stdout, which Vercel captures fine.
    bufferLogs: false,
    cors: false,
    // The WhatsApp webhook verifies Meta's HMAC over the exact bytes received.
    rawBody: true,
  });
  configureHttpApp(app);
  await app.init();
  return app.getHttpAdapter().getInstance() as RequestListener;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`bootstrap timed out after ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  if (!handlerPromise) {
    handlerPromise = bootstrap().catch((err) => {
      // Reset so the next request retries a fresh bootstrap instead of being
      // stuck on a permanently rejected promise.
      handlerPromise = null;
      throw err;
    });
  }

  let listener: RequestListener;
  try {
    // Guard against a hung bootstrap (e.g. DB connect retry storm).
    listener = await withTimeout(handlerPromise, 20_000);
  } catch (err) {
    // Details go to the logs and Sentry, never to the client.
    const e = err instanceof Error ? err : new Error(String(err));
    logger.error(`bootstrap failed: ${e.stack ?? e.message}`);
    Sentry.captureException(e);
    if (!res.headersSent) {
      res.statusCode = 503;
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Retry-After', '5');
      res.end(
        JSON.stringify({
          success: false,
          error: {
            code: 'SERVICE_UNAVAILABLE',
            message: 'Service is starting, please retry.',
          },
        }),
      );
    }
    return;
  }
  listener(req, res);
}
