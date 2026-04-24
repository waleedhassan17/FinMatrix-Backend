import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    cors: false,
  });
  app.useLogger(app.get(PinoLogger));

  const config = app.get(ConfigService);
  const port = config.get<number>('PORT') || config.get<number>('app.port', 3000);
  const globalPrefix = config.get<string>('API_PREFIX') || config.get<string>('app.globalPrefix', 'api/v1');
  const nodeEnv = config.get<string>('NODE_ENV') || config.get<string>('app.nodeEnv', 'development');
  const isProd = nodeEnv === 'production';

  // Trust proxy headers (required behind load balancer / Heroku)
  app.getHttpAdapter().getInstance().set('trust proxy', 1);

  // Security headers
  app.use(helmet({
    contentSecurityPolicy: isProd ? undefined : false,
    crossOriginEmbedderPolicy: false,
  }));

  // Gzip compression
  app.use(compression());

  // Signed cookies
  app.use(cookieParser(config.get('COOKIE_SECRET') || 'cookie-secret'));

  // CORS — strict in prod, permissive in dev
  const corsOrigins = (config.get<string>('CORS_ORIGINS') || '*').split(',').map((s) => s.trim());
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
      forbidNonWhitelisted: true,
      transformOptions: { enableImplicitConversion: true },
    }),
  );

  // Swagger — only when enabled
  if (config.get<boolean>('SWAGGER_ENABLED', true)) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('FinMatrix API')
      .setDescription('Accounting + Delivery Management backend')
      .setVersion('1.0')
      .addBearerAuth()
      .addServer(config.get<string>('APP_URL') || 'http://localhost:3000')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(config.get('SWAGGER_PATH') || 'api/docs', app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // Graceful shutdown
  app.enableShutdownHooks();

  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(
    `FinMatrix backend [${nodeEnv}] listening on http://localhost:${port}/${globalPrefix}  (Swagger: /api/docs)`,
  );
}

bootstrap().catch((err) => {
  console.error('Failed to start:', err);
  process.exit(1);
});
