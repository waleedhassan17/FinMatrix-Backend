# FinMatrix Backend — Deployment Guide

## Targets covered here

- Self-hosted Linux host via Docker
- Managed Postgres (RDS / Render / Neon / Supabase / etc.)

---

## 1. Environment

Create a `.env` file from `.env.example`. Critical variables:

| Variable | Required | Notes |
|---|---|---|
| `NODE_ENV` | yes | Must be `production` |
| `PORT` | yes | Default `3000` |
| `GLOBAL_PREFIX` | yes | `api/v1` |
| `DB_HOST`, `DB_PORT`, `DB_USERNAME`, `DB_PASSWORD`, `DB_NAME` | yes | Managed Postgres credentials |
| `DB_SYNCHRONIZE` | **MUST be `false`** | Use migrations in prod |
| `JWT_SECRET` | yes | Long random string — never commit |
| `JWT_ACCESS_EXPIRES_IN` | yes | e.g. `15m` |
| `JWT_REFRESH_EXPIRES_IN` | yes | e.g. `30d` |
| `BCRYPT_COST` | yes | `12` or higher |
| `THROTTLE_TTL_SECONDS` / `THROTTLE_LIMIT` | yes | Rate limit |
| `LOG_LEVEL` | yes | `info` in prod |

---

## 2. Build once

```bash
npm ci --legacy-peer-deps
npm run build          # emits dist/
```

---

## 3. Generate and run migrations

Local dev still uses `synchronize: true`. For production, freeze the schema into migrations:

```bash
# 1. Generate the initial migration (after pointing DB env at an empty database)
npm run migration:generate -- src/database/migrations/InitialSchema

# 2. Inspect the generated file, commit it.

# 3. In the production deploy step:
npm run migration:run
```

`migration:run` runs against the DataSource in `src/database/data-source.ts`.

---

## 4. Start in production

```bash
NODE_ENV=production npm run start:prod
```

Use a process supervisor (`systemd`, `pm2`, Kubernetes, Docker restart policy) to keep it alive.

Minimal `Dockerfile` (put at repo root):

```dockerfile
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci --legacy-peer-deps
COPY . .
RUN npm run build

FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package*.json ./
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
EXPOSE 3000
CMD ["node", "dist/main.js"]
```

---

## 5. Health check

After deploy, verify:

- `GET /api/v1/health` → `{ "success": true, "data": { "status": "ok", ... } }`
- `GET /api/docs` → Swagger loads
- Create one admin via `POST /api/v1/auth/signup`, then `POST /api/v1/companies`, then `GET /api/v1/auth/me` to confirm JWT + company membership work.

---

## 6. Runbook

**Rotate JWT secret:** change `JWT_SECRET`, redeploy. All access tokens are invalidated; existing refresh tokens stored by hash will fail verification (users re-auth). This is intentional.

**Drop a revoked session manually:**
```sql
UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = '...';
```

**Force-void a bad invoice:**
```
POST /api/v1/invoices/:id/void   { "reason": "manual correction" }
```
Prefer this over raw SQL — it creates the reversing journal entry + balance fixup.

**Inspect account balance trail:**
```
GET /api/v1/accounts/:accountId/transactions?page=1&limit=50
```

---

## 7. Checklist before going live

- [ ] `NODE_ENV=production`
- [ ] `DB_SYNCHRONIZE=false`
- [ ] `JWT_SECRET` is long & random, stored in secrets manager
- [ ] HTTPS terminated in front of the app
- [ ] CORS origin restricted to your frontend host (edit `main.ts`)
- [ ] Helmet enabled (already default)
- [ ] `@nestjs/throttler` rate limit values appropriate for load
- [ ] Postgres backups configured
- [ ] Demo seed NOT run in production (`npm run seed:demo` only in dev)
- [ ] Structured logs shipped to centralized sink (e.g. Loki, Datadog)
- [ ] Swagger at `/api/docs` behind auth or disabled for production if desired
