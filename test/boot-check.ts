/**
 * Resolves the whole DI graph and exits.
 *
 * `tsc --noEmit` cannot see a missing module export or a circular import —
 * those only surface when Nest actually wires the providers. Run this after
 * touching module imports/exports:
 *
 *   npx ts-node -r tsconfig-paths/register test/boot-check.ts
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';

NestFactory.create(AppModule, { logger: ['error'] })
  .then(async (app) => {
    await app.init();
    console.log('BOOT_OK: DI graph resolved');
    await app.close();
    process.exit(0);
  })
  .catch((e: unknown) => {
    console.error('BOOT_FAILED:', String((e as Error)?.message ?? e).slice(0, 1500));
    process.exit(1);
  });
