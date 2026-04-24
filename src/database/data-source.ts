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
      ssl: { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === 'true' },
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

