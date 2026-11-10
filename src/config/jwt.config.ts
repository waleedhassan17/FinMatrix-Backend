import { registerAs } from '@nestjs/config';

export default registerAs('jwt', () => ({
  secret: process.env.JWT_SECRET ?? 'dev_only_change_me',
  /**
   * Signs refresh tokens only. Kept apart from `secret` so a refresh token can
   * never pass the access-token check (JwtStrategy). Falls back to `secret`
   * only where env validation is not in force (scripts, tests).
   */
  refreshSecret:
    process.env.JWT_REFRESH_SECRET ??
    process.env.JWT_SECRET ??
    'dev_only_change_me',
  accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN ?? '15m',
  refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN ?? '30d',
}));
