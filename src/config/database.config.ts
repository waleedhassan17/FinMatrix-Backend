import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export default registerAs(
  'database',
  (): TypeOrmModuleOptions => {
    const isProd = process.env.NODE_ENV === 'production';
    return {
      type: 'postgres',
      host: process.env.DB_HOST ?? 'localhost',
      port: parseInt(process.env.DB_PORT ?? '5432', 10),
      username: process.env.DB_USERNAME ?? 'finmatrix_user',
      password: process.env.DB_PASSWORD ?? 'finmatrix_pass_change_me',
      database: process.env.DB_NAME ?? 'finmatrix',
      entities: [__dirname + '/../**/*.entity{.ts,.js}'],
      autoLoadEntities: true,
      migrations: ['dist/database/migrations/*.js'],
      migrationsRun: process.env.DB_MIGRATIONS_RUN === 'true',
      synchronize:
        !isProd && (process.env.DB_SYNCHRONIZE ?? 'false').toLowerCase() === 'true',
      logging:
        (process.env.DB_LOGGING ?? 'false').toLowerCase() === 'true'
          ? ['query', 'error', 'warn']
          : ['error', 'warn'],
      ssl:
        process.env.DB_SSL === 'true'
          ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
          : false,
      extra: {
        max: parseInt(process.env.DB_POOL_MAX || '10', 10),
        min: parseInt(process.env.DB_POOL_MIN || '2', 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        statement_timeout: 30000,
        query_timeout: 30000,
      },
      retryAttempts: isProd ? 10 : 3,
      retryDelay: 3000,
    };
  },
);
