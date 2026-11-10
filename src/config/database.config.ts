import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { parseBoolean } from '../common/utils/env.util';

interface ParsedDatabaseUrl {
  host: string;
  port: number;
  username: string;
  password: string;
  database: string;
  /** `?sslmode=` from the URL, lower-cased; '' when absent. */
  sslMode: string;
  /** `?ssl=` from the URL, lower-cased; '' when absent. */
  sslParam: string;
}

/**
 * Parse DATABASE_URL (postgres://user:pass@host:port/dbname?sslmode=require)
 * into individual pieces. Heroku, Render, Railway, Neon, Supabase etc. all
 * provide connection info this way.
 */
export function parseDatabaseUrl(url: string): ParsedDatabaseUrl {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: parseInt(u.port || '5432', 10),
    username: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, '')),
    sslMode: (u.searchParams.get('sslmode') ?? '').toLowerCase(),
    sslParam: (u.searchParams.get('ssl') ?? '').toLowerCase(),
  };
}

const URL_SSL_ON = ['require', 'verify-ca', 'verify-full', 'no-verify'];
const URL_SSL_VERIFY = ['verify-ca', 'verify-full'];

/**
 * Whether to use TLS. The most specific setting wins:
 *
 *  1. The URL itself: `?sslmode=disable` turns it off; `?sslmode=require`
 *     (or verify-ca / verify-full / no-verify) or `?ssl=true` turns it on.
 *     The URL's sslmode used to be parsed and then ignored.
 *  2. DB_SSL=true|false.
 *  3. Otherwise on whenever DATABASE_URL is used, because managed providers
 *     (Heroku, Render, Railway, Neon, Supabase, RDS) require it, and off for
 *     discrete DB_* fields.
 *
 * Step 3 is a default, not a rule. It used to be unconditional, so
 * DB_SSL=false was ignored whenever DATABASE_URL was set, and a plain Postgres
 * with no TLS (every CI service container, every self-hosted database) failed
 * to connect at all.
 */
export function resolveDatabaseSsl(parsed: ParsedDatabaseUrl | null): boolean {
  if (parsed?.sslMode === 'disable') return false;
  if (
    parsed &&
    (URL_SSL_ON.includes(parsed.sslMode) || parsed.sslParam === 'true')
  ) {
    return true;
  }
  return parseBoolean(process.env.DB_SSL) ?? parsed !== null;
}

/**
 * Whether the server certificate must chain to a trusted CA. The most
 * specific setting wins:
 *
 *  1. The URL: `?sslmode=verify-ca|verify-full` verifies, `no-verify` does not.
 *  2. DB_SSL_REJECT_UNAUTHORIZED=true|false.
 *  3. Otherwise verify whenever TLS was asked for explicitly (DB_SSL=true),
 *     and do not when TLS is only on by the DATABASE_URL default.
 *
 * Step 3 keeps every existing deployment as it was. An explicit DB_SSL=true
 * has always verified unless told otherwise, so a database that passes
 * verification today keeps being verified. The DATABASE_URL default is new:
 * those connections used to be plaintext. Encrypting them without
 * verification is strictly better, and verifying would refuse the
 * self-signed certificates most managed providers present (Heroku, Render,
 * Railway). To verify there too, add the provider's CA (NODE_EXTRA_CA_CERTS)
 * and set DB_SSL_REJECT_UNAUTHORIZED=true.
 */
export function resolveRejectUnauthorized(
  parsed: ParsedDatabaseUrl | null,
): boolean {
  if (parsed && URL_SSL_VERIFY.includes(parsed.sslMode)) return true;
  if (parsed?.sslMode === 'no-verify') return false;
  return (
    parseBoolean(process.env.DB_SSL_REJECT_UNAUTHORIZED) ??
    parseBoolean(process.env.DB_SSL) === true
  );
}

export default registerAs('database', (): TypeOrmModuleOptions => {
  const isProd = process.env.NODE_ENV === 'production';
  const dbUrl = process.env.DATABASE_URL;
  const parsed = dbUrl ? parseDatabaseUrl(dbUrl) : null;

  return {
    type: 'postgres',
    host: parsed?.host ?? process.env.DB_HOST ?? 'localhost',
    port: parsed?.port ?? parseInt(process.env.DB_PORT ?? '5432', 10),
    username: parsed?.username ?? process.env.DB_USERNAME ?? 'finmatrix_user',
    password:
      parsed?.password ?? process.env.DB_PASSWORD ?? 'finmatrix_pass_change_me',
    database: parsed?.database ?? process.env.DB_NAME ?? 'finmatrix',
    entities: [__dirname + '/../**/*.entity{.ts,.js}'],
    autoLoadEntities: true,
    migrations: ['dist/database/migrations/*.js'],
    migrationsRun: parseBoolean(process.env.DB_MIGRATIONS_RUN) === true,
    // Never in production, whatever the environment says: synchronize can
    // drop columns to make the schema match the entities.
    synchronize: !isProd && parseBoolean(process.env.DB_SYNCHRONIZE) === true,
    logging:
      parseBoolean(process.env.DB_LOGGING) === true
        ? ['query', 'error', 'warn']
        : ['error', 'warn'],
    ssl: resolveDatabaseSsl(parsed)
      ? { rejectUnauthorized: resolveRejectUnauthorized(parsed) }
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
});
