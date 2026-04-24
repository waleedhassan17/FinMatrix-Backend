import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'staging', 'production').default('development'),
  PORT: Joi.number().default(3000),
  API_PREFIX: Joi.string().default('api/v1'),
  APP_NAME: Joi.string().default('FinMatrix'),
  APP_URL: Joi.string().uri().required(),

  // Accept either a single DATABASE_URL (Heroku/Render/Neon/...) OR the
  // discrete DB_* fields. When DATABASE_URL is set the discrete fields are
  // ignored by database.config.ts.
  DATABASE_URL: Joi.string().uri({ scheme: ['postgres', 'postgresql'] }).optional(),
  DB_HOST: Joi.string().when('DATABASE_URL', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().when('DATABASE_URL', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  DB_PASSWORD: Joi.string().min(12).when('DATABASE_URL', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  DB_NAME: Joi.string().when('DATABASE_URL', { is: Joi.exist(), then: Joi.optional(), otherwise: Joi.required() }),
  DB_SYNCHRONIZE: Joi.boolean().default(false),
  DB_LOGGING: Joi.boolean().default(false),
  DB_SSL: Joi.boolean().default(false),
  DB_SSL_REJECT_UNAUTHORIZED: Joi.boolean().default(true),
  DB_POOL_MAX: Joi.number().default(10),
  DB_POOL_MIN: Joi.number().default(2),
  DB_MIGRATIONS_RUN: Joi.boolean().default(false),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('30d'),
  BCRYPT_ROUNDS: Joi.number().min(10).max(14).default(12),

  CORS_ORIGINS: Joi.string().required(),
  THROTTLE_TTL: Joi.number().default(60),
  THROTTLE_LIMIT: Joi.number().default(100),
  COOKIE_SECRET: Joi.string().min(32).required(),

  LOG_LEVEL: Joi.string().valid('trace', 'debug', 'info', 'warn', 'error', 'fatal').default('info'),
  LOG_PRETTY: Joi.boolean().default(false),

  UPLOAD_MAX_SIZE_MB: Joi.number().default(5),
  UPLOAD_STORAGE_PATH: Joi.string().default('./storage'),

  EMAIL_ENABLED: Joi.boolean().default(false),
  SMTP_HOST: Joi.string().when('EMAIL_ENABLED', { is: true, then: Joi.required() }),
  SMTP_PORT: Joi.number().when('EMAIL_ENABLED', { is: true, then: Joi.required() }),
  SMTP_USER: Joi.string().when('EMAIL_ENABLED', { is: true, then: Joi.required() }),
  SMTP_PASSWORD: Joi.string().when('EMAIL_ENABLED', { is: true, then: Joi.required() }),
  SMTP_FROM: Joi.string().when('EMAIL_ENABLED', { is: true, then: Joi.required() }),

  SWAGGER_ENABLED: Joi.boolean().default(true),
  SWAGGER_PATH: Joi.string().default('api/docs'),
}).unknown(true);
