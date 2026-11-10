import { registerAs } from '@nestjs/config';

/**
 * Reads the variable names env.validation.ts validates (and app.json / the
 * deploy guides set) first. The older names are still honoured, but used to
 * be the only ones read: setting BCRYPT_ROUNDS or THROTTLE_TTL did nothing.
 */
export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  globalPrefix: process.env.API_PREFIX ?? process.env.GLOBAL_PREFIX ?? 'api/v1',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  bcryptCost: parseInt(
    process.env.BCRYPT_ROUNDS ?? process.env.BCRYPT_COST ?? '12',
    10,
  ),
  throttleTtlSeconds: parseInt(
    process.env.THROTTLE_TTL ?? process.env.THROTTLE_TTL_SECONDS ?? '60',
    10,
  ),
  throttleLimit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
}));
