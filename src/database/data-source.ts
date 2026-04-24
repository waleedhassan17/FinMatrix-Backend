import 'reflect-metadata';
import { DataSource } from 'typeorm';
import { config as loadEnv } from 'dotenv';

loadEnv();

/**
 * Standalone DataSource used by the TypeORM CLI for generating/running
 * migrations. Keep it aligned with config/database.config.ts.
 */
export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME ?? 'finmatrix_user',
  password: process.env.DB_PASSWORD ?? 'finmatrix_pass_change_me',
  database: process.env.DB_NAME ?? 'finmatrix',
  entities: ['src/**/*.entity.ts'],
  migrations: ['src/database/migrations/*.ts'],
  synchronize: false,
  logging: false,
});
