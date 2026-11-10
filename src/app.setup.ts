import { INestApplication, Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';

/**
 * The HTTP pipeline every entry point shares: src/main.ts (long-running
 * server) and api/index.ts (Vercel). Kept in one place because the two copies
 * had drifted — the serverless one was missing the Idempotency-Key CORS
 * header, so browsers could not send it there.
 */
export function configureHttpApp(app: INestApplication): {
  globalPrefix: string;
  isProd: boolean;
} {
  const config = app.get(ConfigService);
  const globalPrefix =
    config.get<string>('API_PREFIX') ||
    config.get<string>('app.globalPrefix', 'api/v1');
  const nodeEnv =
    config.get<string>('NODE_ENV') ||
    config.get<string>('app.nodeEnv', 'development');
  const isProd = nodeEnv === 'production';

  // Trust proxy headers (required behind a load balancer / Heroku / Vercel)
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Security headers
  app.use(
    helmet({
      contentSecurityPolicy: isProd ? undefined : false,
      crossOriginEmbedderPolicy: false,
    }),
  );

  // Gzip compression
  app.use(compression());

  // Signed cookies (COOKIE_SECRET is required by env validation)
  app.use(cookieParser(config.get<string>('COOKIE_SECRET')));

  // CORS — strict in prod, permissive in dev
  const corsOrigins = (config.get<string>('CORS_ORIGINS') || '*')
    .split(',')
    .map((s) => s.trim());
  if (isProd && corsOrigins.includes('*')) {
    new Logger('Bootstrap').warn(
      'CORS_ORIGINS allows every origin (*) in production. List the web app origins instead.',
    );
  }
  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (corsOrigins.includes('*') || corsOrigins.includes(origin)) {
        return callback(null, true);
      }
      // Refuse by omitting the CORS headers (the browser blocks the call).
      // Passing an Error here turned every disallowed preflight into a 500.
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-Request-Id',
      'X-Company-Id',
      'Idempotency-Key',
    ],
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

  return { globalPrefix, isProd };
}
