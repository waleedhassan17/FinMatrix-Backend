import databaseConfig from './database.config';
import mailConfig from './mail.config';
import appConfig from './app.config';
import { envValidationSchema } from './env.validation';

/** Run `fn` with exactly these env vars set (and the listed others unset). */
function withEnv<T>(
  vars: Record<string, string | undefined>,
  fn: () => T,
  clear: string[] = [],
): T {
  const keys = [...new Set([...Object.keys(vars), ...clear])];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) {
      const v = vars[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    return fn();
  } finally {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const DB_KEYS = ['DATABASE_URL', 'DB_SSL', 'DB_SSL_REJECT_UNAUTHORIZED'];
const URL = 'postgres://u:p@db.example.com:5432/app';

describe('database config', () => {
  const ssl = (vars: Record<string, string | undefined>) =>
    withEnv(
      vars,
      () => (databaseConfig() as Record<string, unknown>).ssl,
      DB_KEYS,
    );

  it.each([
    [
      'DATABASE_URL alone: TLS on, unverified',
      { DATABASE_URL: URL },
      { rejectUnauthorized: false },
    ],
    [
      'DB_SSL=false opts out (CI, self-hosted)',
      { DATABASE_URL: URL, DB_SSL: 'false' },
      false,
    ],
    [
      'DB_SSL is case-insensitive',
      { DATABASE_URL: URL, DB_SSL: 'FALSE' },
      false,
    ],
    [
      '?sslmode=disable opts out',
      { DATABASE_URL: `${URL}?sslmode=disable` },
      false,
    ],
    [
      '?sslmode=require wins over DB_SSL=false',
      { DATABASE_URL: `${URL}?sslmode=require`, DB_SSL: 'false' },
      { rejectUnauthorized: false },
    ],
    [
      '?sslmode=verify-full verifies the certificate',
      { DATABASE_URL: `${URL}?sslmode=verify-full` },
      { rejectUnauthorized: true },
    ],
    [
      'Heroku / AWS settings',
      {
        DATABASE_URL: URL,
        DB_SSL: 'true',
        DB_SSL_REJECT_UNAUTHORIZED: 'false',
      },
      { rejectUnauthorized: false },
    ],
    [
      // Before, a Joi default made this verify; it must not silently stop.
      'explicit DB_SSL=true keeps verifying, as it always did',
      { DATABASE_URL: URL, DB_SSL: 'true' },
      { rejectUnauthorized: true },
    ],
    [
      'managed DB with its CA installed',
      { DATABASE_URL: URL, DB_SSL_REJECT_UNAUTHORIZED: 'true' },
      { rejectUnauthorized: true },
    ],
    ['discrete DB_* fields: TLS off by default', {}, false],
    [
      'discrete DB_* fields with DB_SSL=true: verified',
      { DB_SSL: 'true' },
      { rejectUnauthorized: true },
    ],
  ] as const)('%s', (_name, vars, expected) => {
    expect(ssl(vars as Record<string, string>)).toEqual(expected);
  });

  it('decodes the credentials and database name from the URL', () => {
    const cfg = withEnv(
      { DATABASE_URL: 'postgres://app%40user:p%23ss@h:6543/my%20db' },
      () => databaseConfig() as Record<string, unknown>,
      DB_KEYS,
    );
    expect(cfg).toMatchObject({
      host: 'h',
      port: 6543,
      username: 'app@user',
      password: 'p#ss',
      database: 'my db',
    });
  });

  it('never synchronizes the schema in production', () => {
    const cfg = withEnv(
      { NODE_ENV: 'production', DB_SYNCHRONIZE: 'true' },
      () => databaseConfig() as Record<string, unknown>,
    );
    expect(cfg.synchronize).toBe(false);
  });
});

describe('mail config', () => {
  it('falls back to SMTP_PASS when SMTP_PASSWORD is set but empty', () => {
    const cfg = withEnv({ SMTP_PASSWORD: '', SMTP_PASS: 'secret' }, () =>
      mailConfig(),
    );
    expect(cfg.pass).toBe('secret');
  });

  it('sends as the SMTP account when SMTP_FROM is not set', () => {
    const cfg = withEnv(
      { SMTP_FROM: undefined, SMTP_USER: 'mailer@finmatrix.pk' },
      () => mailConfig(),
    );
    expect(cfg.from).toBe('FinMatrix <mailer@finmatrix.pk>');
  });

  it('keeps an explicit SMTP_FROM', () => {
    const cfg = withEnv(
      { SMTP_FROM: 'FinMatrix <no-reply@finmatrix.pk>', SMTP_USER: 'AKIAKEY' },
      () => mailConfig(),
    );
    expect(cfg.from).toBe('FinMatrix <no-reply@finmatrix.pk>');
  });

  it('reads EMAIL_ENABLED and SMTP_SECURE the way Joi validated them', () => {
    const cfg = withEnv({ EMAIL_ENABLED: 'TRUE', SMTP_SECURE: 'True' }, () =>
      mailConfig(),
    );
    expect(cfg.enabled).toBe(true);
    expect(cfg.secure).toBe(true);
  });
});

describe('app config', () => {
  it('reads the validated variable names', () => {
    const cfg = withEnv(
      { BCRYPT_ROUNDS: '13', THROTTLE_TTL: '120', API_PREFIX: 'api/v2' },
      () => appConfig(),
      ['BCRYPT_COST', 'THROTTLE_TTL_SECONDS', 'GLOBAL_PREFIX'],
    );
    expect(cfg).toMatchObject({
      bcryptCost: 13,
      throttleTtlSeconds: 120,
      globalPrefix: 'api/v2',
    });
  });
});

describe('env validation', () => {
  const base = {
    APP_URL: 'https://api.example.com',
    DATABASE_URL: URL,
    JWT_SECRET: 'a'.repeat(32),
    JWT_REFRESH_SECRET: 'b'.repeat(32),
    COOKIE_SECRET: 'c'.repeat(32),
    CORS_ORIGINS: 'https://app.example.com',
    CREDENTIAL_ENCRYPTION_KEY: 'd'.repeat(32),
  };
  const validate = (vars: Record<string, string>) =>
    envValidationSchema.validate(
      { ...base, ...vars },
      { allowUnknown: true, abortEarly: false },
    );

  it('keeps Swagger off in production unless asked for', () => {
    expect(validate({ NODE_ENV: 'production' }).value.SWAGGER_ENABLED).toBe(
      false,
    );
    expect(
      validate({ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }).value
        .SWAGGER_ENABLED,
    ).toBe(true);
    expect(validate({ NODE_ENV: 'development' }).value.SWAGGER_ENABLED).toBe(
      true,
    );
  });

  // @nestjs/config writes validated defaults back into process.env, so a
  // default here would read as an explicit DB_SSL=false in database.config.ts.
  it('does not invent DB_SSL / DB_SSL_REJECT_UNAUTHORIZED values', () => {
    const { value, error } = validate({ NODE_ENV: 'production' });
    expect(error).toBeUndefined();
    expect(value).not.toHaveProperty('DB_SSL');
    expect(value).not.toHaveProperty('DB_SSL_REJECT_UNAUTHORIZED');
  });

  it('still requires the production-only encryption key', () => {
    const { error } = envValidationSchema.validate(
      { ...base, CREDENTIAL_ENCRYPTION_KEY: undefined, NODE_ENV: 'production' },
      { allowUnknown: true },
    );
    expect(error?.message).toMatch(/CREDENTIAL_ENCRYPTION_KEY/);
  });
});
