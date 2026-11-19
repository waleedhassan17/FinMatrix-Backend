import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { configureHttpApp } from './app.setup';

/**
 * Every header the web app sets on a request must be in the CORS list, or a
 * browser's preflight refuses the request before it is sent — which no test
 * that calls the API from Node can see.
 */
describe('configureHttpApp: CORS', () => {
  function corsOptions() {
    let cors: any = null;
    const values: Record<string, string> = {
      CORS_ORIGINS: 'http://localhost:5173',
      COOKIE_SECRET: 'x'.repeat(32),
      NODE_ENV: 'production',
    };
    const app = {
      get: (t: unknown) =>
        t === ConfigService
          ? { get: (k: string, d?: string) => values[k] ?? d }
          : null,
      getHttpAdapter: () => ({ getInstance: () => ({ set: () => undefined }) }),
      use: () => undefined,
      enableCors: (o: unknown) => (cors = o),
      setGlobalPrefix: () => undefined,
      useGlobalPipes: () => undefined,
    } as unknown as INestApplication;
    configureHttpApp(app);
    return cors as { allowedHeaders: string[]; methods: string[] };
  }

  it("allows every header the web app sends, including each upload piece's SHA-256", () => {
    const allowed = corsOptions().allowedHeaders.map((h) => h.toLowerCase());
    for (const h of [
      'content-type',
      'authorization',
      'x-company-id',
      'idempotency-key',
      'x-part-sha256',
    ])
      expect(allowed).toContain(h);
  });

  it('allows PUT, which sends each piece of a large upload', () => {
    expect(corsOptions().methods).toContain('PUT');
  });
});
