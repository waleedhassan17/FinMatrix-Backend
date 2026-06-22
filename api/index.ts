/**
 * Vercel serverless entry point for the FinMatrix NestJS backend.
 *
 * Vercel runs each request through a (possibly cold) lambda. We bootstrap the
 * Nest application once per warm instance and cache it, then hand the raw
 * Node req/res to the underlying Express adapter for every subsequent call.
 *
 * `src/main.ts` is still used for local/dev (`npm run start:dev`) and any
 * traditional always-on host; this file only exists for the Vercel runtime.
 */
import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { ExpressAdapter } from '@nestjs/platform-express';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import express, { Request, Response } from 'express';
import helmet from 'helmet';

const expressApp = express();
let bootstrapPromise: Promise<void> | null = null;

async function bootstrap(): Promise<void> {
  // Lazy import so any module-load error (missing dep, decorator failure) is
  // caught by the handler's try/catch instead of crashing the whole function.
  const { AppModule } = await import('../src/app.module');
  const app = await NestFactory.create(AppModule, new ExpressAdapter(expressApp), {
    // Pino's buffered logger does not fit the serverless lifecycle; the default
    // Nest logger writes straight to stdout, which Vercel captures fine.
    bufferLogs: false,
    cors: false,
  });

  const config = app.get(ConfigService);
  const globalPrefix = config.get<string>('API_PREFIX') || 'api/v1';

  // Trust Vercel's proxy so secure cookies / rate-limit IPs work.
  expressApp.set('trust proxy', 1);

  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(compression());
  app.use(cookieParser(config.get('COOKIE_SECRET') || 'cookie-secret'));

  const corsOrigins = (config.get<string>('CORS_ORIGINS') || '*')
    .split(',')
    .map((s) => s.trim());
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (corsOrigins.includes('*') || corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Blocked by CORS'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id', 'X-Company-Id'],
    exposedHeaders: ['X-Request-Id', 'X-Total-Count'],
    maxAge: 86400,
  });

  app.setGlobalPrefix(globalPrefix);
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  await app.init();
}

export default async function handler(req: Request, res: Response) {
  if (!bootstrapPromise) {
    bootstrapPromise = bootstrap().catch((err) => {
      // Reset so the next request retries a fresh bootstrap instead of being
      // stuck on a permanently rejected promise.
      bootstrapPromise = null;
      throw err;
    });
  }
  try {
    await bootstrapPromise;
  } catch (err) {
    // TEMPORARY boot-error surfacing: Vercel returns an opaque
    // FUNCTION_INVOCATION_FAILED, so expose the real cause in the response to
    // diagnose. Remove once the deployment is healthy.
    const e = err as Error;
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        bootError: e?.message ?? String(err),
        name: e?.name,
        stack: (e?.stack ?? '').split('\n').slice(0, 12),
      }),
    );
    return;
  }
  expressApp(req, res);
}
