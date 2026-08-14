import 'reflect-metadata';
import { DataSource, DataSourceOptions } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv();

/**
 * Standalone DataSource used by the TypeORM CLI for generating/running
 * migrations. Keep it aligned with config/database.config.ts.
 *
 * Supports DATABASE_URL (Heroku, Render, Neon, Supabase, Railway, ...) OR
 * discrete DB_* variables.
 */
/**
 * SSL policy for a DATABASE_URL connection.
 *
 * Managed providers (Heroku, Render, Railway, Neon, Supabase) require SSL and
 * mostly present self-signed certificates, so SSL-on is the right default here.
 * But it used to be UNCONDITIONAL, which meant DB_SSL=false was ignored the
 * moment DATABASE_URL was set — and a plain Postgres with no TLS then failed
 * with "The server does not support SSL connections". That is every CI service
 * container and every self-hosted database, and it was breaking the acceptance
 * workflow at the migration step.
 *
 * Opt out with DB_SSL=false or ?sslmode=disable in the URL; default stays on.
 */
function sslForUrl(url: string): false | { rejectUnauthorized: boolean } {
  if ((process.env.DB_SSL ?? '').toLowerCase() === 'false') return false;
  try {
    const sslmode = new URL(url).searchParams.get('sslmode');
    if (sslmode === 'disable') return false;
  } catch {
    // Not parseable as a URL — fall through to the secure default.
  }
  return { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' };
}

function buildOptions(): DataSourceOptions {
  const dbUrl = process.env.DATABASE_URL;
  const isCompiled = __filename.endsWith('.js');
  const entities = isCompiled
    ? ['dist/**/*.entity.js']
    : ['src/**/*.entity.ts'];
  const migrations = isCompiled
    ? ['dist/database/migrations/*.js']
    : ['src/database/migrations/*.ts'];

  if (dbUrl) {
    return {
      type: 'postgres',
      url: dbUrl,
      entities,
      migrations,
      synchronize: false,
      logging: false,
      ssl: sslForUrl(dbUrl),
    };
  }

  return {
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USERNAME ?? 'finmatrix_user',
    password: process.env.DB_PASSWORD ?? 'finmatrix_pass_change_me',
    database: process.env.DB_NAME ?? 'finmatrix',
    entities,
    migrations,
    synchronize: false,
    logging: false,
    ssl:
      process.env.DB_SSL === 'true'
        ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
        : false,
  };
}

export const AppDataSource = new DataSource(buildOptions());

