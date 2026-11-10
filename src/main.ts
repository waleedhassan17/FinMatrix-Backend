// Sentry MUST initialize before anything else (phase6) — keep this first.
import './instrument';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { Logger as PinoLogger } from 'nestjs-pino';
import * as Sentry from '@sentry/nestjs';
import { AppModule } from './app.module';
import { configureHttpApp } from './app.setup';

/**
 * Last-resort handlers. Without them a single promise rejection nobody awaited
 * terminates the process under Node's default — but only when SENTRY_DSN is
 * unset, because Sentry installs a non-fatal handler of its own. Behaviour
 * should not depend on whether monitoring is configured.
 *
 *  - unhandledRejection: report and keep serving; one stray promise must not
 *    take down every in-flight request.
 *  - uncaughtException: report, then exit. State may be corrupt; the
 *    orchestrator (ECS / Heroku) restarts a clean process.
 */
function installProcessHandlers(): void {
  const logger = new Logger('Process');
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    logger.error(`Unhandled promise rejection: ${err.stack ?? err.message}`);
    Sentry.captureException(err);
  });
  process.on('uncaughtException', (err) => {
    logger.error(`Uncaught exception, exiting: ${err.stack ?? err.message}`);
    Sentry.captureException(err);
    void Sentry.flush(2000).finally(() => process.exit(1));
  });
}

async function bootstrap() {
  installProcessHandlers();
  const app = await NestFactory.create(AppModule, {
    bufferLogs: true,
    cors: false,
    // FinMatrix Connect: the WhatsApp webhook verifies Meta's HMAC signature
    // over the exact bytes received (req.rawBody); parsed JSON is unchanged.
    rawBody: true,
  });
  app.useLogger(app.get(PinoLogger));

  const config = app.get(ConfigService);
  const port =
    config.get<number>('PORT') || config.get<number>('app.port', 3000);
  const nodeEnv =
    config.get<string>('NODE_ENV') ||
    config.get<string>('app.nodeEnv', 'development');
  const { globalPrefix, isProd } = configureHttpApp(app);

  // Swagger — only when enabled (off by default in production, see env.validation.ts)
  const swaggerEnabled = config.get<boolean>('SWAGGER_ENABLED', !isProd);
  const swaggerPath = config.get<string>('SWAGGER_PATH') || 'api/docs';
  if (swaggerEnabled) {
    const swaggerConfig = new DocumentBuilder()
      .setTitle('FinMatrix API')
      .setDescription('Accounting + Delivery Management backend')
      .setVersion('1.0')
      .addBearerAuth()
      .addServer(config.get<string>('APP_URL') || 'http://localhost:3000')
      .build();
    const document = SwaggerModule.createDocument(app, swaggerConfig);
    SwaggerModule.setup(swaggerPath, app, document, {
      swaggerOptions: { persistAuthorization: true },
    });
  }

  // Graceful shutdown
  app.enableShutdownHooks();

  await app.listen(port, '0.0.0.0');
  // eslint-disable-next-line no-console
  console.log(
    `FinMatrix backend [${nodeEnv}] listening on http://localhost:${port}/${globalPrefix}` +
      (swaggerEnabled ? `  (Swagger: /${swaggerPath})` : ''),
  );
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start:', err);
  process.exit(1);
});
