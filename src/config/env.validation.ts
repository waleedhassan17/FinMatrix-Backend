import * as Joi from 'joi';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string()
    .valid('development', 'test', 'staging', 'production')
    .default('development'),
  PORT: Joi.number().default(3000),
  API_PREFIX: Joi.string().default('api/v1'),
  APP_NAME: Joi.string().default('FinMatrix'),
  APP_URL: Joi.string().uri().required(),

  // Accept either a single DATABASE_URL (Heroku/Render/Neon/...) OR the
  // discrete DB_* fields. When DATABASE_URL is set the discrete fields are
  // ignored by database.config.ts.
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgres', 'postgresql'] })
    .optional(),
  DB_HOST: Joi.string().when('DATABASE_URL', {
    is: Joi.exist(),
    then: Joi.optional(),
    otherwise: Joi.required(),
  }),
  DB_PORT: Joi.number().default(5432),
  DB_USERNAME: Joi.string().when('DATABASE_URL', {
    is: Joi.exist(),
    then: Joi.optional(),
    otherwise: Joi.required(),
  }),
  DB_PASSWORD: Joi.string().min(12).when('DATABASE_URL', {
    is: Joi.exist(),
    then: Joi.optional(),
    otherwise: Joi.required(),
  }),
  DB_NAME: Joi.string().when('DATABASE_URL', {
    is: Joi.exist(),
    then: Joi.optional(),
    otherwise: Joi.required(),
  }),
  DB_SYNCHRONIZE: Joi.boolean().default(false),
  DB_LOGGING: Joi.boolean().default(false),
  // No Joi defaults on these two. @nestjs/config writes validated defaults
  // back into process.env, so `.default(false)` made DB_SSL look explicitly
  // false and silently turned off database.config.ts's "SSL on by default for
  // DATABASE_URL". The defaults live in database.config.ts.
  DB_SSL: Joi.boolean().optional(),
  DB_SSL_REJECT_UNAUTHORIZED: Joi.boolean().optional(),
  DB_POOL_MAX: Joi.number().default(10),
  DB_POOL_MIN: Joi.number().default(2),
  DB_MIGRATIONS_RUN: Joi.boolean().default(false),

  JWT_SECRET: Joi.string().min(32).required(),
  JWT_ACCESS_EXPIRES_IN: Joi.string().default('15m'),
  JWT_REFRESH_SECRET: Joi.string().min(32).required(),
  JWT_REFRESH_EXPIRES_IN: Joi.string().default('30d'),
  BCRYPT_ROUNDS: Joi.number().min(10).max(14).default(12),

  /**
   * Encrypts the custodian's copy of owner-issued staff and rider passwords.
   *
   * REQUIRED in production, because without it the failure is silent: the
   * vault reports itself unconfigured, storeCredential logs a warning and
   * returns, and the owner discovers months later that "Show login" has been
   * answering null the whole time. An account with no self-service reset and
   * no stored credential is an account nobody can recover.
   *
   * Optional elsewhere so a dev box without it still boots — the vault warns
   * loudly enough there, and nothing is at stake.
   *
   *   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
   */
  CREDENTIAL_ENCRYPTION_KEY: Joi.string().min(32).when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),

  CORS_ORIGINS: Joi.string().required(),
  THROTTLE_TTL: Joi.number().default(60),
  THROTTLE_LIMIT: Joi.number().default(100),
  // Sign-in limits (modules/auth/signin-throttle.ts holds the defaults).
  SIGNIN_ACCOUNT_LIMIT: Joi.number().integer().min(1).optional(),
  SIGNIN_ACCOUNT_TTL_SECONDS: Joi.number().integer().min(1).optional(),
  SIGNIN_IP_LIMIT: Joi.number().integer().min(1).optional(),
  COOKIE_SECRET: Joi.string().min(32).required(),

  LOG_LEVEL: Joi.string()
    .valid('trace', 'debug', 'info', 'warn', 'error', 'fatal')
    .default('info'),
  LOG_PRETTY: Joi.boolean().default(false),

  UPLOAD_MAX_SIZE_MB: Joi.number().default(5),
  UPLOAD_STORAGE_PATH: Joi.string().default('./storage'),
  // Largest item photo accepted before processing; every photo is stored
  // downsized, so this only bounds what a phone may send.
  ITEM_IMAGE_MAX_SIZE_MB: Joi.number().default(10),
  // Signs item-photo URLs (MediaUrlSigner). Optional: without it a key is
  // derived from JWT_SECRET. Setting it lets the signing key rotate on its own.
  MEDIA_URL_SECRET: Joi.string().min(32).optional(),

  EMAIL_ENABLED: Joi.boolean().default(false),
  SMTP_HOST: Joi.string().when('EMAIL_ENABLED', {
    is: true,
    then: Joi.required(),
  }),
  SMTP_PORT: Joi.number().when('EMAIL_ENABLED', {
    is: true,
    then: Joi.required(),
  }),
  SMTP_SECURE: Joi.boolean().default(false),
  SMTP_USER: Joi.string().when('EMAIL_ENABLED', {
    is: true,
    then: Joi.required(),
  }),
  // SMTP_PASS is accepted as an alias for SMTP_PASSWORD (see mail.config.ts).
  SMTP_PASSWORD: Joi.string().allow('').optional(),
  SMTP_PASS: Joi.string().allow('').optional(),
  // Optional Reply-To for every email, e.g. a support inbox.
  SMTP_REPLY_TO: Joi.string().allow('').optional(),
  SMTP_FROM: Joi.string().when('EMAIL_ENABLED', {
    is: true,
    then: Joi.required(),
  }),

  // ── Stage 1: deep links, platform admin seed, OTP/verification tuning ──
  APP_DEEP_LINK_SCHEME: Joi.string().default('finmatrix'),
  WEB_FALLBACK_URL: Joi.string().uri().optional(),
  ADMIN_EMAIL: Joi.string().email().optional(),
  ADMIN_PASSWORD: Joi.string().optional(),
  ADMIN_NAME: Joi.string().optional(),
  OTP_TTL_MINUTES: Joi.number().default(10),
  OTP_MAX_ATTEMPTS: Joi.number().default(5),
  VERIFICATION_TTL_HOURS: Joi.number().default(24),

  // ── FinMatrix Connect (WhatsApp Cloud API). All optional. ──
  // WHATSAPP_ENABLED=false (default) swaps in the fake provider: nothing
  // reaches Meta, statuses are simulated. MESSAGING_WORKER_ENABLED=false stops
  // this process from dispatching (and from running the reminder crons).
  WHATSAPP_ENABLED: Joi.boolean().default(false),
  WHATSAPP_GRAPH_VERSION: Joi.string()
    .pattern(/^v\d+\.\d+$/)
    .optional(),
  WHATSAPP_PHONE_NUMBER_ID: Joi.string().allow('').optional(),
  WHATSAPP_WABA_ID: Joi.string().allow('').optional(),
  WHATSAPP_ACCESS_TOKEN: Joi.string().allow('').optional(),
  WHATSAPP_APP_SECRET: Joi.string().allow('').optional(),
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: Joi.string().allow('').optional(),
  // 32 bytes, base64. Encrypts a company's own access token at rest.
  MESSAGING_ENCRYPTION_KEY: Joi.string()
    .allow('')
    .custom((value: string, helpers) => {
      if (value === '') return value;
      return Buffer.from(value, 'base64').length === 32
        ? value
        : helpers.error('any.invalid');
    }, '32-byte base64 key')
    .optional(),
  MESSAGING_WORKER_ENABLED: Joi.boolean().default(true),

  // ── Company backup (modules/data-portability) ──
  // Signs the download link of a finished backup ZIP (ExportTokenSigner). The
  // link carries its own authorisation — a browser's <a href> and a phone's
  // download manager send no bearer header — so this key is what stands
  // between a guessed export id and the whole company's books. REQUIRED in
  // production for that reason; elsewhere a key is derived from JWT_SECRET
  // under its own label, so a dev box boots without it.
  EXPORT_TOKEN_SECRET: Joi.string().min(32).when('NODE_ENV', {
    is: 'production',
    then: Joi.required(),
    otherwise: Joi.optional(),
  }),
  // false stops this process from building queued backups (the rows still
  // queue; another process drains them). Mirrors MESSAGING_WORKER_ENABLED.
  EXPORT_WORKER_ENABLED: Joi.boolean().default(true),
  // How long a finished ZIP stays downloadable before the hourly sweep deletes
  // it and marks the export expired. 24 h is the product contract.
  EXPORT_RETENTION_HOURS: Joi.number().integer().min(1).max(168).default(24),

  // ── Migration Center (modules/migrations) ──
  // Largest single upload (XLSX, CSV, XML or ZIP) the Migration Center reads.
  MIGRATION_MAX_FILE_BYTES: Joi.number()
    .integer()
    .min(1_048_576)
    .max(104_857_600)
    .default(26_214_400),
  // Optional AI mapping assistant. Off by default; with it off (or without a
  // key or model) the Migration Center maps with its deterministic rules only.
  // The model is configuration, never code: e.g. MIGRATION_AI_MODEL=claude-opus-5-5.
  ANTHROPIC_API_KEY: Joi.string().allow('').optional(),
  MIGRATION_AI_ENABLED: Joi.boolean().default(false),
  MIGRATION_AI_MODEL: Joi.string()
    .allow('')
    .when('MIGRATION_AI_ENABLED', {
      is: true,
      then: Joi.string().min(1).required(),
      otherwise: Joi.optional(),
    }),
  // Calls to the model per migration batch, all sessions together.
  MIGRATION_AI_MAX_CALLS: Joi.number().integer().min(0).max(50).default(10),
  // Server-side refusal fallback (beta). Set false for a model that does not support it.
  MIGRATION_AI_SERVER_FALLBACK: Joi.boolean().default(true),

  // API docs are public when on, so production has to opt in.
  SWAGGER_ENABLED: Joi.boolean().when('NODE_ENV', {
    is: 'production',
    then: Joi.boolean().default(false),
    otherwise: Joi.boolean().default(true),
  }),
  SWAGGER_PATH: Joi.string().default('api/docs'),
}).unknown(true);
