import { registerAs } from '@nestjs/config';

export default registerAs('app', () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  globalPrefix: process.env.GLOBAL_PREFIX ?? 'api/v1',
  logLevel: process.env.LOG_LEVEL ?? 'info',
  bcryptCost: parseInt(process.env.BCRYPT_COST ?? '12', 10),
  throttleTtlSeconds: parseInt(process.env.THROTTLE_TTL_SECONDS ?? '60', 10),
  throttleLimit: parseInt(process.env.THROTTLE_LIMIT ?? '100', 10),
}));
